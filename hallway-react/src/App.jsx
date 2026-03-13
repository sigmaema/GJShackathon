import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import './App.css'
import { supabase } from './lib/supabase'

let catalogRowsCache = null
let catalogRowsPromise = null

function App() {
  const mountRef = useRef(null)
  const motionBlurRef = useRef(null)
  const pressedThisFrameRef = useRef({})
  const uiCardLogRef = useRef({ visible: false, key: '' })
  const [paintingInfo, setPaintingInfo] = useState({
    hasSelection: false,
    selectionKey: '',
    side: 'left',
    imageUrl: '',
    title: '',
    artist: '',
    year: '',
    style: '',
    description: 'Turn left or right to inspect a painting.',
  })
  const [lastSelectedInfo, setLastSelectedInfo] = useState(null)

  const pressKey = (key) => {
    if (!pressedThisFrameRef.current[key]) {
      pressedThisFrameRef.current[key] = true
    }
  }

  useEffect(() => {
    const prev = uiCardLogRef.current
    if (paintingInfo.hasSelection) {
      if (!prev.visible || prev.key !== paintingInfo.selectionKey) {
        console.log('[ui] side-card show', {
          key: paintingInfo.selectionKey,
          side: paintingInfo.side,
          title: paintingInfo.title,
          artist: paintingInfo.artist,
          year: paintingInfo.year,
        })
      }
      uiCardLogRef.current = { visible: true, key: paintingInfo.selectionKey }
      return
    }

    if (prev.visible) {
      console.log('[ui] side-card hide')
    }
    uiCardLogRef.current = { visible: false, key: '' }
  }, [
    paintingInfo.hasSelection,
    paintingInfo.selectionKey,
    paintingInfo.side,
    paintingInfo.title,
    paintingInfo.artist,
    paintingInfo.year,
  ])

  useEffect(() => {
    if (paintingInfo.hasSelection) {
      setLastSelectedInfo(paintingInfo)
    }
  }, [paintingInfo])

  useEffect(() => {
    if (!mountRef.current) return undefined

    // Scene setup
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x2a2a2a)
    scene.fog = new THREE.Fog(0x2a2a2a, 50, 200)

    const BASE_VERTICAL_FOV = 75
    const BASE_ASPECT = 16 / 9
    const baseHorizontalFov = 2 * Math.atan(Math.tan((THREE.MathUtils.degToRad(BASE_VERTICAL_FOV)) / 2) * BASE_ASPECT)

    const camera = new THREE.PerspectiveCamera(BASE_VERTICAL_FOV, window.innerWidth / window.innerHeight, 0.1, 1000)
    camera.position.set(0, 1.6, 0)

    function updateCameraProjection() {
      const width = window.innerWidth
      const height = window.innerHeight
      const aspect = width / height

      // Keep horizontal framing stable so fullscreen on wide monitors does not make the hallway look stretched.
      const verticalFovRad = 2 * Math.atan(Math.tan(baseHorizontalFov / 2) / aspect)
      camera.fov = THREE.MathUtils.radToDeg(verticalFovRad)
      camera.aspect = aspect
      camera.updateProjectionMatrix()
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    mountRef.current.appendChild(renderer.domElement)

    // Player movement
    const player = {
      position: new THREE.Vector3(0, 0, 0),
      direction: 0,
      moveDistance: 5,
      rotationSpeed: Math.PI / 2,
    }

    const view = {
      position: player.position.clone(),
      direction: player.direction,
    }

    const stepAnimation = {
      active: false,
      startTime: 0,
      durationMs: 800,
      fromPosition: new THREE.Vector3(),
      toPosition: new THREE.Vector3(),
      fromDirection: 0,
      toDirection: 0,
    }

    const MOVE_DURATION_MS = 800
    const TURN_DURATION_MS = 1000

    let blurUntil = 0
    function triggerMotionBlur(durationMs = 140) {
      blurUntil = Math.max(blurUntil, performance.now() + durationMs)
    }

    function moveForward() {
      const moveDistance = player.moveDistance
      player.position.z -= moveDistance * Math.cos(player.direction)
      player.position.x -= moveDistance * Math.sin(player.direction)
    }

    function moveBackward() {
      const moveDistance = player.moveDistance
      player.position.z += moveDistance * Math.cos(player.direction)
      player.position.x += moveDistance * Math.sin(player.direction)
    }

    function turnLeft() {
      player.direction += player.rotationSpeed
    }

    function turnRight() {
      player.direction -= player.rotationSpeed
    }

    function normalizeAngle(angle) {
      let a = angle
      while (a > Math.PI) a -= Math.PI * 2
      while (a < -Math.PI) a += Math.PI * 2
      return a
    }

    function startStep(action) {
      if (stepAnimation.active) {
        return
      }

      console.log('[movement] startStep', {
        action,
        from: {
          x: Number(view.position.x.toFixed(2)),
          z: Number(view.position.z.toFixed(2)),
          dir: Number(view.direction.toFixed(3)),
        },
      })

      stepAnimation.fromPosition.copy(view.position)
      stepAnimation.fromDirection = view.direction

      if (action === 'forward' || action === 'backward') {
        stepAnimation.durationMs = MOVE_DURATION_MS
      } else {
        stepAnimation.durationMs = TURN_DURATION_MS
      }

      if (action === 'forward') moveForward()
      if (action === 'backward') moveBackward()
      if (action === 'turnLeft') turnLeft()
      if (action === 'turnRight') turnRight()

      stepAnimation.toPosition.copy(player.position)
      stepAnimation.toDirection = player.direction
      stepAnimation.startTime = performance.now()
      stepAnimation.active = true
      triggerMotionBlur(stepAnimation.durationMs + 40)

      console.log('[movement] targetStep', {
        action,
        to: {
          x: Number(stepAnimation.toPosition.x.toFixed(2)),
          z: Number(stepAnimation.toPosition.z.toFixed(2)),
          dir: Number(stepAnimation.toDirection.toFixed(3)),
        },
      })
    }

    function easeInOut(t) {
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
    }

    const DEFAULT_PAINTING_HEIGHT = 1.6
    const DEFAULT_PAINTING_WIDTH = 1.2
    const PAINTING_WORLD_UNITS_PER_PIXEL = 0.0016
    const MAX_PAINTING_HEIGHT = 2.2
    const MIN_PAIR_STEP = 3.2
    const PAIR_GAP = 1.1
    const SIDE_LEFT_X = -2.4
    const SIDE_RIGHT_X = 2.4
    const FALLBACK_MAX_Z_DISTANCE = 4.8
    const SIDE_LOOKAHEAD_FACTOR = 0.2

    const fallbackCatalog = [
      { title: 'Untitled Study I', artist: 'Unknown', year: '1881', style: 'Unknown', description: 'Oil on panel.' },
      { title: 'Harbor at Dusk', artist: 'Unknown', year: '1902', style: 'Unknown', description: 'Coastal evening scene.' },
      { title: 'Portrait in Red', artist: 'Unknown', year: '1910', style: 'Unknown', description: 'Formal portrait.' },
      { title: 'The Orchard Path', artist: 'Unknown', year: '1896', style: 'Unknown', description: 'Landscape with trees.' },
      { title: 'City Rain', artist: 'Unknown', year: '1921', style: 'Unknown', description: 'Urban impression.' },
      { title: 'Blue Interior', artist: 'Unknown', year: '1930', style: 'Unknown', description: 'Domestic scene.' },
    ]

    let paintingCatalog = []
    let catalogCursor = 0
    let rafId = 0
    let lastLoggedSelectionKey = ''
    let loggedNoSelection = false
    let lastValidSelection = null
    let lastValidSelectionAt = 0
    // Keep the last selected painting visible through short raycast gaps while stepping.
    const SELECTION_HOLD_MS = 1400

    function normalizeImageUrl(painting) {
      const raw = painting.photo_link || painting.image_url || painting.url || painting.image || painting.image_path || ''
      return typeof raw === 'string' ? raw.trim() : ''
    }

    function getWorldSizeFromPixels(imageWidth, imageHeight) {
      const heightInWorld = imageHeight * PAINTING_WORLD_UNITS_PER_PIXEL
      const clampScale = heightInWorld > MAX_PAINTING_HEIGHT ? MAX_PAINTING_HEIGHT / heightInWorld : 1
      return {
        width: imageWidth * PAINTING_WORLD_UNITS_PER_PIXEL * clampScale,
        height: imageHeight * PAINTING_WORLD_UNITS_PER_PIXEL * clampScale,
      }
    }

    function getPaintingWorldSize(painting) {
      const imageWidth = Number(painting?.imageWidth) || 0
      const imageHeight = Number(painting?.imageHeight) || 0
      if (imageWidth > 0 && imageHeight > 0) {
        return getWorldSizeFromPixels(imageWidth, imageHeight)
      }

      const fallbackAspect = painting?.aspectRatio || (DEFAULT_PAINTING_WIDTH / DEFAULT_PAINTING_HEIGHT)
      return {
        width: DEFAULT_PAINTING_HEIGHT * fallbackAspect,
        height: DEFAULT_PAINTING_HEIGHT,
      }
    }

    function loadImageMetadata(url) {
      if (!url) {
        return Promise.resolve({ imageWidth: 0, imageHeight: 0, aspectRatio: 1 })
      }

      return new Promise((resolve) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          if (img.width && img.height) {
            resolve({
              imageWidth: img.width,
              imageHeight: img.height,
              aspectRatio: img.width / img.height,
            })
          } else {
            resolve({ imageWidth: 0, imageHeight: 0, aspectRatio: 1 })
          }
        }
        img.onerror = () => resolve({ imageWidth: 0, imageHeight: 0, aspectRatio: 1 })
        img.src = url
      })
    }

    async function loadPaintingCatalog() {
      if (catalogRowsCache) {
        paintingCatalog = catalogRowsCache
        console.log('[supabase] using cached catalog', { count: paintingCatalog.length })
        return
      }

      if (catalogRowsPromise) {
        paintingCatalog = await catalogRowsPromise
        console.log('[supabase] using in-flight catalog promise', { count: paintingCatalog.length })
        return
      }

      try {
        catalogRowsPromise = (async () => {
          let data = null
          let sourceTable = 'artworks2'

          const mapRows = (rows) => rows.map((item) => ({
            title: item.artwork_name || item.title || 'Untitled',
            artist: item.author_name || item.artist || 'Unknown Artist',
            year: item.year || '',
            style: item.style || '',
            description: item.description || item.description_cs || 'No description available.',
            photo_link: item.photo_link,
            image_url: item.image_url,
            url: item.url,
            image: item.image,
            image_path: item.image_path,
          }))

          // Primary source table configured for this project.
          const artworksResp = await supabase
            .from('artworks2')
            .select('*')
            .order('id', { ascending: true })

          if (!artworksResp.error && artworksResp.data && artworksResp.data.length > 0) {
            console.log(
              '[supabase] raw photo_link column',
              artworksResp.data.map((row) => ({
                title: row.artwork_name || row.title,
                photo_link: row.photo_link,
              }))
            )
            data = mapRows(artworksResp.data)
          } else {
            console.log('[supabase] artworks2 query failed or empty', {
              error: artworksResp.error,
              rowCount: artworksResp.data?.length || 0,
            })

            // Secondary fallback for existing seeded table naming.
            const legacyResp = await supabase
              .from('Artworks')
              .select('*')
              .order('id', { ascending: true })

            if (!legacyResp.error && legacyResp.data && legacyResp.data.length > 0) {
              sourceTable = 'Artworks'
              console.log('[supabase] using fallback table Artworks', { rowCount: legacyResp.data.length })
              data = mapRows(legacyResp.data)
            } else {
              console.log('[supabase] Artworks query failed or empty', {
                error: legacyResp.error,
                rowCount: legacyResp.data?.length || 0,
              })
            }
          }

          if (!data || data.length === 0) {
            console.log('[supabase] no rows from artworks2/Artworks, using fallback catalog')
            console.error(
              '[supabase] Zero visible rows. Most likely causes: (1) RLS blocks anon SELECT, (2) table has no rows in this project, (3) rows are in a different schema/project. Run SQL checks in Supabase SQL editor.'
            )
            return fallbackCatalog
          }

          const normalized = data.map((item) => ({
            title: item.title,
            artist: item.artist,
            year: item.year || '',
            style: item.style || '',
            description: item.description || 'No description available.',
            image_url: normalizeImageUrl(item),
          }))

          const withImageMetadata = await Promise.all(
            normalized.map(async (item) => ({
              ...item,
              ...(await loadImageMetadata(item.image_url)),
            }))
          )

          console.log('[supabase] loaded paintings', {
            sourceTable,
            count: withImageMetadata.length,
            withImageUrl: withImageMetadata.filter((p) => Boolean(p.image_url)).length,
          })
          console.log('[supabase] photo_link values', withImageMetadata.map((p) => ({
            title: p.title,
            photo_link: p.image_url,
          })))

          return withImageMetadata
        })()

        paintingCatalog = await catalogRowsPromise
        catalogRowsCache = paintingCatalog
      } catch (err) {
        console.log('[supabase] failed, using fallback catalog', err)
        paintingCatalog = fallbackCatalog
      } finally {
        catalogRowsPromise = null
      }
    }

    function nextCatalogPainting() {
      if (paintingCatalog.length === 0) {
        paintingCatalog = fallbackCatalog
      }

      const painting = paintingCatalog[catalogCursor % paintingCatalog.length]
      catalogCursor += 1
      return painting
    }

    // Create hallway floor
    const floorGeometry = new THREE.PlaneGeometry(5, 500)
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x444444 })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    floor.position.z = -250
    scene.add(floor)

    // Create hallway ceiling
    const ceilingGeometry = new THREE.PlaneGeometry(5, 500)
    const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0x666666 })
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial)
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.y = 3
    ceiling.position.z = -250
    ceiling.receiveShadow = true
    scene.add(ceiling)

    // Create hallway walls
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 })

    const leftWallGeometry = new THREE.PlaneGeometry(500, 3)
    const leftWall = new THREE.Mesh(leftWallGeometry, wallMaterial)
    leftWall.rotation.y = Math.PI / 2
    leftWall.position.x = -2.5
    leftWall.position.y = 1.5
    leftWall.position.z = -250
    leftWall.receiveShadow = true
    scene.add(leftWall)

    const rightWallGeometry = new THREE.PlaneGeometry(500, 3)
    const rightWall = new THREE.Mesh(rightWallGeometry, wallMaterial)
    rightWall.rotation.y = -Math.PI / 2
    rightWall.position.x = 2.5
    rightWall.position.y = 1.5
    rightWall.position.z = -250
    rightWall.receiveShadow = true
    scene.add(rightWall)

    const artworks = []
    const artworkMeshes = []
    const raycaster = new THREE.Raycaster()
    const screenCenter = new THREE.Vector2(0, 0)

    function createPlaceholderTexture(painting, hue) {
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 1024
      const ctx = canvas.getContext('2d')
      if (!ctx) return new THREE.CanvasTexture(canvas)

      ctx.fillStyle = `hsl(${hue}, 55%, 38%)`
      ctx.fillRect(0, 0, 1024, 1024)

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.lineWidth = 24
      ctx.strokeRect(24, 24, 976, 976)

      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.font = 'bold 62px Georgia'
      ctx.fillText(painting.title || 'Untitled', 512, 470)
      ctx.font = '42px Georgia'
      ctx.fillText(painting.artist || 'Unknown Artist', 512, 545)
      if (painting.year) {
        ctx.fillText(String(painting.year), 512, 605)
      }

      return new THREE.CanvasTexture(canvas)
    }

    function applyImageTextureIfAvailable(material, mesh, imageUrl) {
      if (!imageUrl) {
        return
      }

      const loader = new THREE.TextureLoader()
      loader.setCrossOrigin('anonymous')
      loader.load(
        imageUrl,
        (loadedTexture) => {
          const img = loadedTexture.image
          if (img && img.width && img.height) {
            const size = getWorldSizeFromPixels(img.width, img.height)
            mesh.scale.set(size.width, size.height, 1)
            mesh.userData.baseScale = mesh.scale.clone()
          }

          if (material.map) {
            material.map.dispose()
          }
          material.map = loadedTexture
          material.needsUpdate = true
        },
        undefined,
        () => {
          // Keep placeholder if image cannot be loaded.
        }
      )
    }

    function addArtwork(painting, x, z, rotation, side, hue) {
      const geometry = new THREE.PlaneGeometry(1, 1)
      const texture = createPlaceholderTexture(painting, hue)
      const material = new THREE.MeshStandardMaterial({ map: texture })
      const mesh = new THREE.Mesh(geometry, material)
      const initialSize = getPaintingWorldSize(painting)
      mesh.scale.set(initialSize.width, initialSize.height, 1)

      mesh.position.set(x, 1.5, z)
      mesh.rotation.y = rotation
      mesh.castShadow = true
      mesh.receiveShadow = true

      scene.add(mesh)
      applyImageTextureIfAvailable(material, mesh, painting.image_url)
      mesh.userData.painting = painting
      mesh.userData.side = side
      mesh.userData.z = z

      artworkMeshes.push(mesh)

      artworks.push({ x, z, rotation, mesh, side, painting })
    }

    function getPaintingWorldWidth(painting) {
      return getPaintingWorldSize(painting).width
    }

    function getPairStep(leftPainting, rightPainting) {
      const pairWidth = Math.max(getPaintingWorldWidth(leftPainting), getPaintingWorldWidth(rightPainting))
      return Math.max(MIN_PAIR_STEP, pairWidth + PAIR_GAP)
    }

    function addArtworkPairAt(z, leftPainting, rightPainting) {
      const leftHue = Math.random() * 360
      const rightHue = Math.random() * 360

      addArtwork(leftPainting, SIDE_LEFT_X, z, Math.PI / 2, 'left', leftHue)
      addArtwork(rightPainting, SIDE_RIGHT_X, z, -Math.PI / 2, 'right', rightHue)
    }

    function addArtworkPair(z) {
      const leftPainting = nextCatalogPainting()
      const rightPainting = nextCatalogPainting()
      addArtworkPairAt(z, leftPainting, rightPainting)
      return getPairStep(leftPainting, rightPainting)
    }

    function addArtworkPairAfter(currentFurthestZ) {
      const leftPainting = nextCatalogPainting()
      const rightPainting = nextCatalogPainting()
      const step = getPairStep(leftPainting, rightPainting)
      const z = currentFurthestZ - step
      addArtworkPairAt(z, leftPainting, rightPainting)
      return z
    }

    function getNearestArtworkOnSide(side, targetZ, maxDistance = Number.POSITIVE_INFINITY) {
      let nearest = null
      let nearestDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < artworks.length; i += 1) {
        const a = artworks[i]
        if (a.side !== side) continue
        const dist = Math.abs(a.z - targetZ)
        if (dist <= maxDistance && dist < nearestDist) {
          nearestDist = dist
          nearest = a
        }
      }
      return nearest
    }

    function updatePaintingInfo() {
      const updateInfoState = (nextState) => {
        setPaintingInfo((prev) => {
          if (
            prev.hasSelection === nextState.hasSelection &&
            prev.selectionKey === nextState.selectionKey &&
            prev.imageUrl === nextState.imageUrl &&
            prev.title === nextState.title &&
            prev.artist === nextState.artist &&
            prev.year === nextState.year &&
            prev.style === nextState.style &&
            prev.description === nextState.description
          ) {
            return prev
          }
          return nextState
        })
      }

      raycaster.setFromCamera(screenCenter, camera)
      const intersections = raycaster.intersectObjects(artworkMeshes, false)
      let hit = intersections[0]

      // Fallback: if center ray misses, use nearest painting on the wall side the user is facing.
      if (!hit || !hit.object || !hit.object.userData || !hit.object.userData.painting) {
        const direction = ((view.direction % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const sideFacing = Math.sin(direction)
        const sideStrength = Math.abs(sideFacing)

        // Accept a wider sideways range so selection can be reacquired reliably while turning.
        if (sideStrength > 0.35) {
          const side = sideFacing > 0 ? 'left' : 'right'
          const fallback = getNearestArtworkOnSide(side, view.position.z, FALLBACK_MAX_Z_DISTANCE)
          if (fallback && fallback.painting) {
            hit = {
              object: {
                userData: {
                  painting: fallback.painting,
                  side: fallback.side,
                  z: fallback.z,
                },
              },
            }
          }
        }
      }

      if (!hit || !hit.object || !hit.object.userData || !hit.object.userData.painting) {
        const now = performance.now()
        if (lastValidSelection && now - lastValidSelectionAt < SELECTION_HOLD_MS) {
          updateInfoState(lastValidSelection)
          return
        }

        if (!loggedNoSelection) {
          console.log('[selection] none')
          loggedNoSelection = true
          lastLoggedSelectionKey = ''
        }
        updateInfoState({
          hasSelection: false,
          selectionKey: '',
          side: 'left',
          imageUrl: '',
          title: '',
          artist: '',
          year: '',
          style: '',
          description: 'Turn left or right to inspect a painting.',
        })
        return
      }

      const painting = hit.object.userData.painting
      const title = painting.title || 'Untitled'
      const artist = painting.artist || 'Unknown Artist'
      const year = painting.year ? String(painting.year) : ''
      const style = painting.style || 'Unknown'
      const description =
        painting.description ||
        painting.desc ||
        painting.details ||
        painting.text ||
        'No description available.'
      const imageUrl = normalizeImageUrl(painting)
      const selectionKey = `${hit.object.userData.side}:${hit.object.userData.z}`
      const side = hit.object.userData.side || 'left'

      if (selectionKey !== lastLoggedSelectionKey) {
        console.log('[selection] painting', {
          key: selectionKey,
          title,
          artist,
          year,
          style,
          description,
          photo_link: imageUrl,
          side: hit.object.userData.side,
          z: hit.object.userData.z,
        })
        lastLoggedSelectionKey = selectionKey
        loggedNoSelection = false
      }
      const nextSelection = { hasSelection: true, selectionKey, side, imageUrl, title, artist, year, style, description }
      lastValidSelection = nextSelection
      lastValidSelectionAt = performance.now()
      updateInfoState(nextSelection)
    }

    async function initializeGallery() {
      await loadPaintingCatalog()
      let z = 0
      while (z >= -70) {
        const step = addArtworkPair(z)
        z -= step
      }
    }

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(5, 10, 5)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.width = 2048
    directionalLight.shadow.mapSize.height = 2048
    scene.add(directionalLight)

    // Keyboard controls
    function onKeyDown(e) {
      const key = e.key.toLowerCase()
      if (!pressedThisFrameRef.current[key]) {
        pressedThisFrameRef.current[key] = true
      }
    }

    // Handle window resize
    function onResize() {
      updateCameraProjection()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    updateCameraProjection()

    // Animation loop
    function animate() {
      rafId = requestAnimationFrame(animate)

      let isMoving = false
      const pressedThisFrame = pressedThisFrameRef.current

      // Handle keyboard/button input as animated one-step actions.
      if (!stepAnimation.active) {
        if (pressedThisFrame.w) {
          startStep('forward')
        } else if (pressedThisFrame.s) {
          startStep('backward')
        } else if (pressedThisFrame.q || pressedThisFrame.a) {
          startStep('turnLeft')
        } else if (pressedThisFrame.e || pressedThisFrame.d) {
          startStep('turnRight')
        } else if (pressedThisFrame.arrowup) {
          startStep('forward')
        } else if (pressedThisFrame.arrowdown) {
          startStep('backward')
        } else if (pressedThisFrame.arrowleft) {
          startStep('turnLeft')
        } else if (pressedThisFrame.arrowright) {
          startStep('turnRight')
        }
      }

      // Interpolate between current and next pose so movement is visible.
      if (stepAnimation.active) {
        const elapsed = performance.now() - stepAnimation.startTime
        const rawT = Math.min(1, elapsed / stepAnimation.durationMs)
        const t = easeInOut(rawT)

        view.position.lerpVectors(stepAnimation.fromPosition, stepAnimation.toPosition, t)
        const deltaDir = normalizeAngle(stepAnimation.toDirection - stepAnimation.fromDirection)
        view.direction = stepAnimation.fromDirection + deltaDir * t
        isMoving = true

        if (rawT >= 1) {
          view.position.copy(stepAnimation.toPosition)
          view.direction = stepAnimation.toDirection
          stepAnimation.active = false
        }
      }

      // Clear pressed keys for next frame
      pressedThisFrameRef.current = {}

      // Motion blur effect
      if (motionBlurRef.current) {
        motionBlurRef.current.style.opacity = isMoving || performance.now() < blurUntil ? '0.15' : '0'
      }

      // Keep forward movement smooth, but when viewing a wall center the nearest painting instead of the gap.
      const sideFacing = Math.sin(view.direction)
      const sideFactor = Math.abs(sideFacing)
      const sideLookAheadOffset = player.moveDistance * sideFactor * SIDE_LOOKAHEAD_FACTOR

      // Update camera position (player position + eye height)
      camera.position.x = view.position.x
      let cameraZ = view.position.z - sideLookAheadOffset

      if (sideFactor > 0.85) {
        const side = sideFacing > 0 ? 'left' : 'right'
        const nearestOnSide = getNearestArtworkOnSide(side, view.position.z, player.moveDistance)
        if (nearestOnSide) {
          cameraZ = THREE.MathUtils.lerp(cameraZ, nearestOnSide.z, 0.82)
        }
      }

      camera.position.z = cameraZ

      // Update camera rotation based on direction
      camera.rotation.order = 'YXZ'
      camera.rotation.y = view.direction
      updatePaintingInfo()

      // Keep creating new artworks ahead to maintain endless hallway effect
      const furthestArtwork = Math.min(...artworks.map((a) => a.z))
      if (player.position.z < furthestArtwork - 15) {
        addArtworkPairAfter(furthestArtwork)
      }

      renderer.render(scene, camera)
    }

    initializeGallery().then(() => {
      animate()
    })

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)

      artworks.forEach(({ mesh }) => {
        mesh.geometry.dispose()
        if (mesh.material.map) mesh.material.map.dispose()
        mesh.material.dispose()
      })

      floorGeometry.dispose()
      floorMaterial.dispose()
      ceilingGeometry.dispose()
      ceilingMaterial.dispose()
      leftWallGeometry.dispose()
      rightWallGeometry.dispose()
      wallMaterial.dispose()
      renderer.dispose()

      if (renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement)
      }
    }
  }, [])

  const activeInfo = paintingInfo.hasSelection ? paintingInfo : lastSelectedInfo
  const selectedInfo = paintingInfo.hasSelection ? paintingInfo : null
  const showCenterModal = Boolean(selectedInfo)

  return (
    <>
      <div className="info">
        <h3>Endless Hallway Gallery</h3>
        <p>Explore the gallery and admire the artwork on the walls.</p>
      </div>

      <div id="motionBlur" ref={motionBlurRef} />

      {showCenterModal ? (
        <>
          <div className="painting-modal-backdrop" aria-hidden="true" />
          <section className="painting-modal" role="dialog" aria-label="Selected painting">
            <div className="painting-modal__media">
              {selectedInfo.imageUrl ? (
                <img src={selectedInfo.imageUrl} alt={selectedInfo.title || 'Selected painting'} className="painting-modal__image" />
              ) : (
                <div className="painting-modal__image painting-modal__image--fallback">Image unavailable</div>
              )}
            </div>
          </section>

          <aside className="painting-side-info" aria-live="polite">
            <p><strong>Name:</strong> {selectedInfo.title}</p>
            <p><strong>Author:</strong> {selectedInfo.artist}</p>
            <p><strong>Year:</strong> {selectedInfo.year || 'Unknown'}</p>
            <p><strong>Style:</strong> {selectedInfo.style || 'Unknown'}</p>
            <p><strong>Description:</strong> {selectedInfo.description}</p>
          </aside>
        </>
      ) : null}

      <div className="controls-hint">
        <p>
          <strong>Keyboard Controls:</strong>
        </p>
        <p>W - Forward</p>
        <p>S - Backward</p>
        <p>Q - Turn Left</p>
        <p>E - Turn Right</p>
      </div>

      <div className="controls">
        <button type="button" className="turnLeft" onClick={() => pressKey('q')}>
          {'<- Turn Left'}
        </button>
        <button type="button" className="forward" onClick={() => pressKey('w')}>
          {'^ Forward'}
        </button>
        <button type="button" className="turnRight" onClick={() => pressKey('e')}>
          {'Turn Right ->'}
        </button>
        <button type="button" className="backward" onClick={() => pressKey('s')}>
          {'v Backward'}
        </button>
      </div>

      <div id="canvas" ref={mountRef} />
    </>
  )
}

export default App