import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import './App.css'
import { supabase } from './lib/supabase'

let catalogRowsCache = null
let catalogRowsPromise = null

function App() {
  const AUDIO_BASE_VOLUME = 0.5
  const AUDIO_FADE_OUT_MS = 450
  const mountRef = useRef(null)
  const motionBlurRef = useRef(null)
  const cursorLightRef = useRef(null)
  const debugHudRef = useRef(null)
  const audioRef = useRef(null)
  const audioFadeRafRef = useRef(0)
  const audioFadeTokenRef = useRef(0)
  const audioUnlockedRef = useRef(false)
  const pendingMusicCandidatesRef = useRef([])
  const pendingMusicIndexRef = useRef(0)
  const pendingActionRef = useRef(null)
  const heldKeysRef = useRef({})
  const uiCardLogRef = useRef({ visible: false, key: '' })
  const paintingInfoRef = useRef(null)
  const [paintingInfo, setPaintingInfo] = useState({
    hasSelection: false,
    selectionKey: '',
    side: 'left',
    imageUrl: '',
    musicUrl: '',
    title: '',
    artist: '',
    year: '',
    style: '',
    description: 'Turn left or right to inspect a painting.',
  })
  const [modalInfo, setModalInfo] = useState(null)

  function cancelAudioFade() {
    if (audioFadeRafRef.current) {
      cancelAnimationFrame(audioFadeRafRef.current)
      audioFadeRafRef.current = 0
    }
    audioFadeTokenRef.current += 1
  }

  function fadeOutAndStopAudio(audio) {
    if (!audio || !audio.src) {
      return
    }

    cancelAudioFade()
    const startVolume = typeof audio.volume === 'number' ? audio.volume : AUDIO_BASE_VOLUME
    const fadeToken = audioFadeTokenRef.current
    const startTime = performance.now()

    const tick = (now) => {
      if (fadeToken !== audioFadeTokenRef.current) {
        return
      }

      const t = Math.min(1, (now - startTime) / AUDIO_FADE_OUT_MS)
      audio.volume = Math.max(0, startVolume * (1 - t))

      if (t < 1) {
        audioFadeRafRef.current = requestAnimationFrame(tick)
        return
      }

      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.volume = AUDIO_BASE_VOLUME
      audioFadeRafRef.current = 0
      console.log('[audio] faded out and stopped')
    }

    audioFadeRafRef.current = requestAnimationFrame(tick)
  }

  const mapKeyToAction = (key) => {
    const normalizedKey = String(key).toLowerCase()
    const actionMap = {
      w: 'forward',
      arrowup: 'forward',
      s: 'backward',
      arrowdown: 'backward',
      q: 'turnLeft',
      a: 'turnLeft',
      arrowleft: 'turnLeft',
      e: 'turnRight',
      d: 'turnRight',
      arrowright: 'turnRight',
    }
    return actionMap[normalizedKey] || null
  }

  const buildMusicCandidates = (rawMusic) => {
    if (!rawMusic || typeof rawMusic !== 'string') {
      return []
    }

    const value = rawMusic.trim()
    if (!value) {
      return []
    }

    const supabaseBase = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
    const candidates = []

    const addCandidate = (url) => {
      if (!url || candidates.includes(url)) {
        return
      }
      candidates.push(url)
    }

    if (/^(https?:|blob:|data:)/i.test(value)) {
      addCandidate(value)
      return candidates
    }

    if (value.startsWith('//')) {
      addCandidate(`${window.location.protocol}${value}`)
      return candidates
    }

    if (value.startsWith('/')) {
      addCandidate(new URL(value, window.location.origin).href)
      if (supabaseBase) {
        addCandidate(`${supabaseBase}${value}`)
      }
      return candidates
    }

    // Candidate as local/public-relative asset.
    addCandidate(new URL(value, window.location.href).href)

    if (supabaseBase) {
      if (/^storage\/v1\/object\/public\//i.test(value)) {
        addCandidate(`${supabaseBase}/${value}`)
      } else if (value.includes('/')) {
        // Common DB format: "bucket/path/to/file.mp3"
        addCandidate(`${supabaseBase}/storage/v1/object/public/${value}`)
      }
    }

    return candidates
  }

  useEffect(() => {
    paintingInfoRef.current = paintingInfo
  }, [paintingInfo])

  const pressKey = (key) => {
    const normalizedKey = String(key).toLowerCase()
    const action = mapKeyToAction(normalizedKey)
    if (action) {
      pendingActionRef.current = action
      console.log('[input] pending action', { key: normalizedKey, action })
    }
  }

  const enqueueAction = (action, source) => {
    if (!action) {
      return
    }
    pendingActionRef.current = action
    console.log('[input] pending action (direct)', { action, source })
  }

  const handleControlPointerDown = (key, e) => {
    e.preventDefault()
    e.stopPropagation()
    const action = mapKeyToAction(key)
    enqueueAction(action, 'button:pointerdown')
  }

  const handleControlMouseDown = (key, e) => {
    e.preventDefault()
    e.stopPropagation()
    const action = mapKeyToAction(key)
    enqueueAction(action, 'button:mousedown')
  }

  const handleControlTouchStart = (key, e) => {
    e.preventDefault()
    e.stopPropagation()
    const action = mapKeyToAction(key)
    enqueueAction(action, 'button:touchstart')
  }

  const handleControlClick = (key, e) => {
    e.preventDefault()
    e.stopPropagation()
    const action = mapKeyToAction(key)
    enqueueAction(action, 'button:click')
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
    if (!modalInfo || !paintingInfo.hasSelection) {
      return
    }

    if (
      modalInfo.selectionKey !== paintingInfo.selectionKey
      || modalInfo.title !== paintingInfo.title
      || modalInfo.artist !== paintingInfo.artist
      || modalInfo.year !== paintingInfo.year
      || modalInfo.style !== paintingInfo.style
      || modalInfo.description !== paintingInfo.description
    ) {
      setModalInfo(paintingInfo)
    }
  }, [
    modalInfo,
    paintingInfo.hasSelection,
    paintingInfo.selectionKey,
    paintingInfo.title,
    paintingInfo.artist,
    paintingInfo.year,
    paintingInfo.style,
    paintingInfo.description,
  ])

  useEffect(() => {
    function onEscape(e) {
      if (e.key === 'Escape') {
        setModalInfo(null)
      }
    }

    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [])

  useEffect(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.loop = true
      audio.volume = AUDIO_BASE_VOLUME
      audio.preload = 'auto'
      audioRef.current = audio
    }

    const audio = audioRef.current
    const targetMusic = paintingInfo.hasSelection ? paintingInfo.musicUrl : ''

    if (!targetMusic) {
      pendingMusicCandidatesRef.current = []
      pendingMusicIndexRef.current = 0
      fadeOutAndStopAudio(audio)
      return
    }

    cancelAudioFade()
    audio.volume = AUDIO_BASE_VOLUME

    const candidates = buildMusicCandidates(targetMusic)
    if (candidates.length === 0) {
      console.log('[audio] no valid music candidates for selection', {
        selectionKey: paintingInfo.selectionKey,
        rawMusic: targetMusic,
      })
      return
    }

    pendingMusicCandidatesRef.current = candidates
    pendingMusicIndexRef.current = 0

    const applyCandidate = (index) => {
      const candidate = candidates[index]
      if (!candidate) {
        return false
      }

      const resolvedTarget = new URL(candidate, window.location.href).href
      if (audio.src !== resolvedTarget) {
        audio.src = candidate
        audio.currentTime = 0
      }

      console.log('[audio] candidate selected', {
        selectionKey: paintingInfo.selectionKey,
        candidateIndex: index,
        candidate,
      })
      return true
    }

    const advanceCandidate = () => {
      const nextIndex = pendingMusicIndexRef.current + 1
      if (nextIndex >= candidates.length) {
        console.log('[audio] exhausted all music candidates', {
          selectionKey: paintingInfo.selectionKey,
          candidates,
        })
        return
      }

      pendingMusicIndexRef.current = nextIndex
      if (applyCandidate(nextIndex)) {
        audio.play().then(() => {
          audioUnlockedRef.current = true
          console.log('[audio] playback started on fallback candidate', {
            selectionKey: paintingInfo.selectionKey,
            candidateIndex: nextIndex,
          })
        }).catch((err) => {
          if (err?.name === 'NotAllowedError') {
            console.log('[audio] autoplay blocked on fallback candidate', err)
            return
          }
          console.log('[audio] fallback candidate play failed', err)
          advanceCandidate()
        })
      }
    }

    const onAudioError = () => {
      console.log('[audio] load error for candidate', {
        selectionKey: paintingInfo.selectionKey,
        candidateIndex: pendingMusicIndexRef.current,
        src: audio.src,
      })
      advanceCandidate()
    }

    audio.addEventListener('error', onAudioError)

    if (!applyCandidate(0)) {
      audio.removeEventListener('error', onAudioError)
      return
    }

    audio.play().then(() => {
      audioUnlockedRef.current = true
      console.log('[audio] playback started', {
        selectionKey: paintingInfo.selectionKey,
        src: audio.src,
      })
    }).catch((err) => {
      if (err?.name === 'NotAllowedError') {
        console.log('[audio] autoplay blocked, waiting for user gesture', err)
        return
      }
      console.log('[audio] initial candidate play failed', err)
      advanceCandidate()
    })

    return () => {
      audio.removeEventListener('error', onAudioError)
    }
  }, [paintingInfo.hasSelection, paintingInfo.musicUrl, paintingInfo.selectionKey])

  useEffect(() => {
    const unlockAudio = () => {
      audioUnlockedRef.current = true
      const audio = audioRef.current
      if (!audio || !audio.paused || !audio.src) {
        return
      }

      audio.play().then(() => {
        console.log('[audio] playback resumed after user gesture', { src: audio.src })
      }).catch((err) => {
        console.log('[audio] user gesture play failed', err)
      })
    }

    window.addEventListener('pointerdown', unlockAudio, { passive: true })
    window.addEventListener('touchstart', unlockAudio, { passive: true })
    window.addEventListener('keydown', unlockAudio)

    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('touchstart', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [])

  useEffect(() => () => {
    cancelAudioFade()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
      audioRef.current.volume = AUDIO_BASE_VOLUME
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mountRef.current) return undefined

    // Scene setup
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a1a)
    scene.fog = new THREE.Fog(0x1a1a1a, 40, 180)

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
    renderer.domElement.style.position = 'absolute'
    renderer.domElement.style.inset = '0'
    renderer.domElement.style.display = 'block'
    // Ensure only one active WebGL canvas is mounted to avoid stale rects after hot reloads.
    mountRef.current.replaceChildren(renderer.domElement)

    // Player movement
    const player = {
      position: new THREE.Vector3(0, 0, 0),
      direction: 0,
      moveDistance: 2,
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
    const FALLBACK_MAX_Z_DISTANCE = 9.5
    const SIDE_LOOKAHEAD_FACTOR = 0.2
    const SPAWN_Z = 1
    const MAX_ARTWORK_COUNT = 30

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
    let hasMoreCatalogPaintings = true
    const pairSequence = []
    let galleryStepIndex = 0
    let rafId = 0
    let lastLoggedSelectionKey = ''
    let loggedNoSelection = false
    let lastValidSelection = null
    let lastValidSelectionAt = 0
    let smoothedCameraZ = player.position.z
    let lockedSelection = null
    // Keep the last selected painting visible through short raycast gaps while stepping.
    const SELECTION_HOLD_MS = 450

    function normalizeImageUrl(painting) {
      const raw = painting.photo_link || painting.image_url || painting.url || painting.image || painting.image_path || ''
      return typeof raw === 'string' ? raw.trim() : ''
    }

    function normalizeMusicUrl(painting) {
      const raw = painting.music || painting.music_url || painting.audio || painting.audio_url || painting.soundtrack || ''
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
            music: item.music,
            music_url: item.music_url,
            audio: item.audio,
            audio_url: item.audio_url,
            soundtrack: item.soundtrack,
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
            music_url: normalizeMusicUrl(item),
          }))

          const withImageMetadata = await Promise.all(
            normalized.map(async (item) => ({
              ...item,
              ...(await loadImageMetadata(item.image_url)),
            }))
          )

          const limitedCatalog = withImageMetadata.slice(0, MAX_ARTWORK_COUNT)

          console.log('[supabase] loaded paintings', {
            sourceTable,
            count: limitedCatalog.length,
            withImageUrl: limitedCatalog.filter((p) => Boolean(p.image_url)).length,
          })
          console.log('[supabase] photo_link values', limitedCatalog.map((p) => ({
            title: p.title,
            photo_link: p.image_url,
          })))

          return limitedCatalog
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

      if (catalogCursor >= paintingCatalog.length) {
        hasMoreCatalogPaintings = false
        return null
      }

      const painting = paintingCatalog[catalogCursor]
      catalogCursor += 1
      if (catalogCursor >= paintingCatalog.length) {
        hasMoreCatalogPaintings = false
      }
      return painting
    }

    function getDisplayPairIndex() {
      const maxIndex = Math.max(0, pairSequence.length - 1)
      let displayIndex = 0

      // Progression rule: +1,+1,+2 repeating by pair groups of 3,
      // plus manual boundaries between 3/4 -> 5/6, 9/10 -> 11/12,
      // 19/20 -> 21/22, 21/22 -> 23/24, and 27/28 -> 29/30.
      // requiredStep(i) = i + floor(i / 3)
      //   + (i >= 2 ? 1 : 0) + (i >= 5 ? 1 : 0)
      //   + (i >= 10 ? 1 : 0) + (i >= 11 ? 1 : 0) + (i >= 14 ? 1 : 0)
      for (let i = 0; i <= maxIndex; i += 1) {
        const requiredStep = i + Math.floor(i / 3) + (i >= 2 ? 1 : 0) + (i >= 5 ? 1 : 0) + (i >= 10 ? 1 : 0) + (i >= 11 ? 1 : 0) + (i >= 14 ? 1 : 0)
        if (galleryStepIndex >= requiredStep) {
          displayIndex = i
        } else {
          break
        }
      }

      return displayIndex
    }

    // Create hallway floor
    const floorTexture = new THREE.TextureLoader().load('/floor.png')
    floorTexture.wrapS = THREE.RepeatWrapping
    floorTexture.wrapT = THREE.RepeatWrapping
    floorTexture.repeat.set(2.5, 180)
    floorTexture.colorSpace = THREE.SRGBColorSpace
    floorTexture.anisotropy = 1
    floorTexture.magFilter = THREE.LinearFilter
    floorTexture.minFilter = THREE.LinearMipmapLinearFilter

    const ceilingTexture = floorTexture.clone()
    ceilingTexture.wrapS = THREE.RepeatWrapping
    ceilingTexture.wrapT = THREE.RepeatWrapping
    ceilingTexture.repeat.set(2.5, 180)
    ceilingTexture.colorSpace = THREE.SRGBColorSpace
    ceilingTexture.anisotropy = 1
    ceilingTexture.magFilter = THREE.LinearFilter
    ceilingTexture.minFilter = THREE.LinearMipmapLinearFilter

    const floorGeometry = new THREE.PlaneGeometry(5, 500)
    const floorMaterial = new THREE.MeshStandardMaterial({
      map: floorTexture,
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.02,
    })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    floor.position.z = -250
    scene.add(floor)

    // Create hallway ceiling
    const ceilingGeometry = new THREE.PlaneGeometry(5, 500)
    const ceilingMaterial = new THREE.MeshStandardMaterial({
      map: ceilingTexture,
      color: 0xf1f1f1,
      roughness: 0.9,
      metalness: 0.02,
    })
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial)
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.y = 3
    ceiling.position.z = -250
    ceiling.receiveShadow = true
    scene.add(ceiling)

    // Create hallway walls
    const wallTexture = new THREE.TextureLoader().load('/wall.png')
    wallTexture.wrapS = THREE.RepeatWrapping
    wallTexture.wrapT = THREE.RepeatWrapping
    wallTexture.repeat.set(80, 2)
    wallTexture.colorSpace = THREE.SRGBColorSpace

    const wallMaterial = new THREE.MeshStandardMaterial({
      map: wallTexture,
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0.02,
    })

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
    const labelMeshes = []
    const raycaster = new THREE.Raycaster()
    const clickRaycaster = new THREE.Raycaster()
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

    function wrapCanvasText(ctx, text, x, startY, maxWidth, lineHeight, maxLines) {
      const words = String(text || '').split(/\s+/).filter(Boolean)
      const lines = []
      let current = ''

      for (let i = 0; i < words.length; i += 1) {
        const test = current ? `${current} ${words[i]}` : words[i]
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current)
          current = words[i]
        } else {
          current = test
        }
      }

      if (current) {
        lines.push(current)
      }

      for (let i = 0; i < Math.min(lines.length, maxLines); i += 1) {
        const needsEllipsis = i === maxLines - 1 && i < lines.length - 1
        ctx.fillText(needsEllipsis ? `${lines[i]}...` : lines[i], x, startY + i * lineHeight)
      }
    }

    function createWallLabelTexture(painting) {
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 560
      const ctx = canvas.getContext('2d')
      if (!ctx) return new THREE.CanvasTexture(canvas)

      ctx.fillStyle = 'rgba(245, 236, 216, 0.95)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.strokeStyle = 'rgba(54, 43, 28, 0.55)'
      ctx.lineWidth = 12
      ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24)

      ctx.fillStyle = '#1c1610'
      ctx.textAlign = 'left'
      ctx.font = 'bold 56px Georgia'
      ctx.fillText(painting.title || 'Untitled', 48, 92)

      const metaParts = [painting.artist || 'Unknown Artist']
      if (painting.year) {
        metaParts.push(String(painting.year))
      }
      if (painting.style) {
        metaParts.push(String(painting.style))
      }

      ctx.font = '32px Georgia'
      ctx.fillStyle = '#3b3022'
      ctx.fillText(metaParts.join(' | '), 48, 150)

      ctx.font = '30px Georgia'
      ctx.fillStyle = '#20180f'
      wrapCanvasText(
        ctx,
        painting.description || 'No description available.',
        48,
        220,
        canvas.width - 96,
        42,
        6
      )

      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      return texture
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

    function createSelectionFromPainting(painting, side, z) {
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
      const musicUrl = normalizeMusicUrl(painting)
      const selectionKey = `${side}:${z}`
      return { hasSelection: true, selectionKey, side, imageUrl, musicUrl, title, artist, year, style, description }
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

      const labelGeometry = new THREE.PlaneGeometry(1.0, 0.56)
      const labelTexture = createWallLabelTexture(painting)
      const labelMaterial = new THREE.MeshStandardMaterial({
        map: labelTexture,
        transparent: true,
        roughness: 0.95,
        metalness: 0.02,
      })
      const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial)
      labelMesh.position.set(side === 'left' ? x + 0.03 : x - 0.03, 1.02, z + 0.95)
      labelMesh.rotation.y = rotation
      labelMesh.receiveShadow = true
      labelMesh.userData.painting = painting
      labelMesh.userData.side = side
      labelMesh.userData.z = z

      scene.add(mesh)
      scene.add(labelMesh)
      applyImageTextureIfAvailable(material, mesh, painting.image_url)
      mesh.userData.painting = painting
      mesh.userData.side = side
      mesh.userData.z = z

      artworkMeshes.push(mesh)
      labelMeshes.push(labelMesh)

      artworks.push({ x, z, rotation, mesh, labelMesh, side, painting })
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

      pairSequence.push({ z, leftPainting, rightPainting })
    }

    function addArtworkPair(z) {
      const leftPainting = nextCatalogPainting()
      const rightPainting = nextCatalogPainting()
      if (!leftPainting || !rightPainting) {
        return null
      }
      addArtworkPairAt(z, leftPainting, rightPainting)
      return getPairStep(leftPainting, rightPainting)
    }

    function addArtworkPairAfter(currentFurthestZ) {
      const leftPainting = nextCatalogPainting()
      const rightPainting = nextCatalogPainting()
      if (!leftPainting || !rightPainting) {
        return null
      }
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

    function findArtworkBySelectionKey(selectionKey) {
      if (!selectionKey) {
        return null
      }

      const [side, zRaw] = String(selectionKey).split(':')
      const targetZ = Number(zRaw)
      if (!Number.isFinite(targetZ)) {
        return null
      }

      for (let i = 0; i < artworks.length; i += 1) {
        const a = artworks[i]
        if (a.side === side && Math.abs(a.z - targetZ) < 0.0001) {
          return a
        }
      }

      return null
    }

    function updatePaintingInfo() {
      const updateInfoState = (nextState) => {
        setPaintingInfo((prev) => {
          if (
            prev.hasSelection === nextState.hasSelection &&
            prev.selectionKey === nextState.selectionKey &&
            prev.imageUrl === nextState.imageUrl &&
            prev.musicUrl === nextState.musicUrl &&
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

      if (lockedSelection) {
        updateInfoState(lockedSelection)
        return
      }

      raycaster.setFromCamera(screenCenter, camera)
      const intersections = raycaster.intersectObjects(artworkMeshes, false)
      let hit = intersections[0]

      // Fallback: if center ray misses, use deterministic pair slot by movement index.
      if (!hit || !hit.object || !hit.object.userData || !hit.object.userData.painting) {
        const direction = ((view.direction % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const sideFacing = Math.sin(direction)
        const sideStrength = Math.abs(sideFacing)

        if (sideStrength > 0.35) {
          const side = sideFacing > 0 ? 'left' : 'right'
          const slot = pairSequence[getDisplayPairIndex()]
          if (slot) {
            const slotPainting = side === 'left' ? slot.leftPainting : slot.rightPainting
            hit = {
              object: {
                userData: {
                  painting: slotPainting,
                  side,
                  z: slot.z,
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
          musicUrl: '',
          title: '',
          artist: '',
          year: '',
          style: '',
          description: 'Turn left or right to inspect a painting.',
        })
        return
      }

      const painting = hit.object.userData.painting
      const selectionKey = `${hit.object.userData.side}:${hit.object.userData.z}`
      const side = hit.object.userData.side || 'left'
      const nextSelection = createSelectionFromPainting(painting, side, hit.object.userData.z)

      if (selectionKey !== lastLoggedSelectionKey) {
        console.log('[selection] painting', {
          key: selectionKey,
          title: nextSelection.title,
          artist: nextSelection.artist,
          year: nextSelection.year,
          style: nextSelection.style,
          description: nextSelection.description,
          photo_link: nextSelection.imageUrl,
          music_url: nextSelection.musicUrl,
          side: hit.object.userData.side,
          z: hit.object.userData.z,
          pairIndex: galleryStepIndex,
          displayPairIndex: getDisplayPairIndex(),
          playerX: Number(player.position.x.toFixed(2)),
          playerZ: Number(player.position.z.toFixed(2)),
          viewX: Number(view.position.x.toFixed(2)),
          viewZ: Number(view.position.z.toFixed(2)),
          cameraX: Number(camera.position.x.toFixed(2)),
          cameraZ: Number(camera.position.z.toFixed(2)),
        })
        lastLoggedSelectionKey = selectionKey
        loggedNoSelection = false
      }
      lastValidSelection = nextSelection
      lastValidSelectionAt = performance.now()
      updateInfoState(nextSelection)
    }

    async function initializeGallery() {
      await loadPaintingCatalog()
      let z = 0
      while (z >= -70) {
        const step = addArtworkPair(z)
        if (!step) {
          break
        }
        z -= step
      }

      // Spawn at z=1 and show paintings 1/2 first.
      player.position.z = SPAWN_Z
      view.position.z = SPAWN_Z
      smoothedCameraZ = SPAWN_Z
      galleryStepIndex = 0
    }

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5)
    directionalLight.position.set(5, 10, 5)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.width = 2048
    directionalLight.shadow.mapSize.height = 2048
    scene.add(directionalLight)

    const selectionLightTarget = new THREE.Object3D()
    scene.add(selectionLightTarget)

    const selectionLight = new THREE.SpotLight(0xfff0ce, 0, 14, THREE.MathUtils.degToRad(30), 0.45, 1.3)
    selectionLight.position.set(0, 2.85, 0)
    selectionLight.castShadow = false
    selectionLight.visible = false
    selectionLight.target = selectionLightTarget
    scene.add(selectionLight)

    // Separate overhead lamp directly above the selected painting.
    const selectionTopLight = new THREE.PointLight(0xfff6d8, 0, 4.5, 1.6)
    selectionTopLight.position.set(0, 2.7, 0)
    selectionTopLight.visible = false
    scene.add(selectionTopLight)

    // Keyboard controls
    function onKeyDown(e) {
      const key = e.key.toLowerCase()
      const movementKeys = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'])
      if (movementKeys.has(key)) {
        e.preventDefault()
      }
      heldKeysRef.current[key] = true
      if (!e.repeat) {
        pressKey(key)
      }
    }

    function onKeyUp(e) {
      const key = e.key.toLowerCase()
      heldKeysRef.current[key] = false
    }

    // Handle window resize
    function onResize() {
      updateCameraProjection()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }

    function updateCursorLightPosition(clientX, clientY) {
      if (!cursorLightRef.current) return
      cursorLightRef.current.style.setProperty('--flash-x', `${clientX}px`)
      cursorLightRef.current.style.setProperty('--flash-y', `${clientY}px`)
    }

    function onPointerMove(e) {
      updateCursorLightPosition(e.clientX, e.clientY)
    }

    function onTouchMove(e) {
      const touch = e.touches && e.touches[0]
      if (!touch) return
      updateCursorLightPosition(touch.clientX, touch.clientY)
    }

    function onPointerDown(e) {
      const target = e.target
      const targetEl = target instanceof Element ? target : null
      const clickedModal = Boolean(targetEl && targetEl.closest('.painting-modal'))
      const clickedBackdrop = Boolean(targetEl && targetEl.closest('.painting-modal-backdrop'))
      const clickedDomCard = Boolean(targetEl && targetEl.closest('.painting-card, .painting-info-card'))
      const currentPaintingInfo = paintingInfoRef.current

      console.log('[click] pointerdown registered', {
        pointerType: e.pointerType,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        targetTag: targetEl?.tagName || null,
        targetClass: targetEl?.className || null,
        clickedModal,
        clickedBackdrop,
        clickedDomCard,
      })

      if (clickedModal || clickedBackdrop) {
        console.log('[click] ignored: modal/backdrop interaction')
        return
      }

      // Only scene clicks should run raycast/modal logic.
      if (!(targetEl instanceof HTMLCanvasElement) || targetEl !== renderer.domElement) {
        console.log('[click] ignored: non-scene click target')
        return
      }

      // Reset stale lock before resolving this click.
      lockedSelection = null

      if (targetEl instanceof HTMLCanvasElement && targetEl !== renderer.domElement) {
        console.log('[click] ignored: non-active canvas target', {
          activeCanvasClass: renderer.domElement.className || null,
          targetCanvasClass: targetEl.className || null,
        })
        return
      }

      const rect = renderer.domElement.getBoundingClientRect()
      const withinCanvasRect = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      console.log('[click] canvas rect', {
        left: Number(rect.left.toFixed(1)),
        top: Number(rect.top.toFixed(1)),
        right: Number(rect.right.toFixed(1)),
        bottom: Number(rect.bottom.toFixed(1)),
        width: Number(rect.width.toFixed(1)),
        height: Number(rect.height.toFixed(1)),
        withinCanvasRect,
      })

      if (!withinCanvasRect) {
        console.log('[click] ignored: pointer outside active canvas rect')
        return
      }

      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      const pointer = new THREE.Vector2(x, y)

      clickRaycaster.setFromCamera(pointer, camera)
      const clickableMeshes = [...labelMeshes, ...artworkMeshes]
      const hits = clickRaycaster.intersectObjects(clickableMeshes, false)

      const firstHit = hits[0]?.object || null
      const clickedWallCard = Boolean(firstHit && labelMeshes.includes(firstHit))
      const clickedPaintingMesh = Boolean(firstHit && artworkMeshes.includes(firstHit))
      console.log('[click] raycast result', {
        normalizedX: Number(x.toFixed(3)),
        normalizedY: Number(y.toFixed(3)),
        hitCount: hits.length,
        clickedWallCard,
        clickedPaintingMesh,
        firstHitHasPainting: Boolean(firstHit?.userData?.painting),
      })

      if (hits.length > 0) {
        const picked = hits[0].object?.userData
        if (picked?.painting) {
          const selection = createSelectionFromPainting(picked.painting, picked.side || 'left', picked.z)
          console.log('[click] opening modal from raycast hit', {
            side: picked.side || 'left',
            z: picked.z,
            title: selection.title,
            artist: selection.artist,
          })
          lastValidSelection = selection
          lastValidSelectionAt = performance.now()
          setPaintingInfo(selection)
          setModalInfo(selection)
          return
        }
      }

      // If user clicks while looking at a painting but misses exact geometry, open focused selection.
      const fallbackSelection = currentPaintingInfo?.hasSelection ? currentPaintingInfo : null
      if (fallbackSelection) {
        console.log('[click] opening modal from focused fallback', {
          selectionKey: fallbackSelection.selectionKey,
          title: fallbackSelection.title,
          artist: fallbackSelection.artist,
        })
        setModalInfo(fallbackSelection)
        return
      }

      // Click outside labels unlocks manual modal selection.
      console.log('[click] no painting resolved, clearing lock')
      lockedSelection = null
    }

    updateCursorLightPosition(window.innerWidth / 2, window.innerHeight / 2)

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown)
    updateCameraProjection()

    // Animation loop
    function animate() {
      rafId = requestAnimationFrame(animate)

      let isMoving = false

      // Handle keyboard/button input as animated one-step actions.
      if (!stepAnimation.active) {
        let nextAction = pendingActionRef.current
        if (!nextAction) {
          const keyPriority = ['w', 'arrowup', 's', 'arrowdown', 'q', 'a', 'arrowleft', 'e', 'd', 'arrowright']
          for (let i = 0; i < keyPriority.length; i += 1) {
            const key = keyPriority[i]
            if (heldKeysRef.current[key]) {
              nextAction = mapKeyToAction(key)
              break
            }
          }
        }

        if (nextAction) {
          if (nextAction === 'forward') {
            galleryStepIndex += 1
          } else if (nextAction === 'backward') {
            galleryStepIndex = Math.max(galleryStepIndex - 1, 0)
          }
          startStep(nextAction)
          pendingActionRef.current = null
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

          console.log('[movement] stepComplete', {
            pairIndex: galleryStepIndex,
            displayPairIndex: getDisplayPairIndex(),
            playerX: Number(player.position.x.toFixed(2)),
            playerZ: Number(player.position.z.toFixed(2)),
            viewX: Number(view.position.x.toFixed(2)),
            viewZ: Number(view.position.z.toFixed(2)),
            cameraX: Number(camera.position.x.toFixed(2)),
            cameraZ: Number(camera.position.z.toFixed(2)),
            direction: Number(view.direction.toFixed(3)),
          })
        }
      }

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
      const baseCameraZ = view.position.z - sideLookAheadOffset
      let targetCameraZ = baseCameraZ

      const side = sideFacing >= 0 ? 'left' : 'right'
      const activePair = pairSequence[getDisplayPairIndex()] || null
      if (activePair) {
        const centerBlend = THREE.MathUtils.smoothstep(sideFactor, 0.6, 0.95)
        targetCameraZ = THREE.MathUtils.lerp(baseCameraZ, activePair.z, centerBlend)
      }

      smoothedCameraZ = THREE.MathUtils.lerp(smoothedCameraZ, targetCameraZ, 0.22)
      camera.position.z = smoothedCameraZ

      // Update camera rotation based on direction
      camera.rotation.order = 'YXZ'
      camera.rotation.y = view.direction
      updatePaintingInfo()

      const activeSelection = paintingInfoRef.current
      if (activeSelection?.hasSelection) {
        const selectionParts = String(activeSelection.selectionKey || '').split(':')
        const selectedZ = Number(selectionParts[1])
        if (Number.isFinite(selectedZ)) {
          const isLeft = activeSelection.side === 'left'
          const sideX = isLeft ? SIDE_LEFT_X : SIDE_RIGHT_X
          const inwardOffset = isLeft ? 0.3 : -0.3
          selectionLight.visible = true
          selectionTopLight.visible = true
          selectionLight.position.set(sideX + inwardOffset, 2.95, selectedZ + 0.08)
          selectionLightTarget.position.set(sideX, 1.45, selectedZ)
          selectionLight.intensity = THREE.MathUtils.lerp(selectionLight.intensity, 2.2, 0.22)
          selectionTopLight.position.set(sideX, 2.6, selectedZ)
          selectionTopLight.intensity = THREE.MathUtils.lerp(selectionTopLight.intensity, 1.4, 0.22)
        } else {
          selectionLight.intensity = THREE.MathUtils.lerp(selectionLight.intensity, 0, 0.16)
          selectionTopLight.intensity = THREE.MathUtils.lerp(selectionTopLight.intensity, 0, 0.16)
          if (selectionLight.intensity < 0.03) {
            selectionLight.visible = false
          }
          if (selectionTopLight.intensity < 0.03) {
            selectionTopLight.visible = false
          }
        }
      } else {
        selectionLight.intensity = THREE.MathUtils.lerp(selectionLight.intensity, 0, 0.16)
        selectionTopLight.intensity = THREE.MathUtils.lerp(selectionTopLight.intensity, 0, 0.16)
        if (selectionLight.intensity < 0.03) {
          selectionLight.visible = false
        }
        if (selectionTopLight.intensity < 0.03) {
          selectionTopLight.visible = false
        }
      }

      // Keep creating new artworks ahead to maintain endless hallway effect
      if (hasMoreCatalogPaintings && artworks.length > 0) {
        const furthestArtwork = Math.min(...artworks.map((a) => a.z))
        if (player.position.z < furthestArtwork - 15) {
          const newFurthest = addArtworkPairAfter(furthestArtwork)
          if (newFurthest === null) {
            hasMoreCatalogPaintings = false
          }
        }
      }

      renderer.render(scene, camera)

      if (debugHudRef.current) {
        debugHudRef.current.textContent = [
          `pair: ${galleryStepIndex} | display: ${getDisplayPairIndex()}`,
          `player x/z: ${player.position.x.toFixed(2)} / ${player.position.z.toFixed(2)}`,
          `view x/z: ${view.position.x.toFixed(2)} / ${view.position.z.toFixed(2)}`,
          `camera x/z: ${camera.position.x.toFixed(2)} / ${camera.position.z.toFixed(2)}`,
          `selection: ${activeSelection?.title || '-'} (${activeSelection?.selectionKey || '-'})`,
        ].join('\n')
      }
    }

    initializeGallery().then(() => {
      animate()
    })

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('pointerdown', onPointerDown)

      artworks.forEach(({ mesh, labelMesh }) => {
        mesh.geometry.dispose()
        if (mesh.material.map) mesh.material.map.dispose()
        mesh.material.dispose()

        if (labelMesh) {
          labelMesh.geometry.dispose()
          if (labelMesh.material.map) labelMesh.material.map.dispose()
          labelMesh.material.dispose()
        }
      })

      floorGeometry.dispose()
      if (floorMaterial.map) floorMaterial.map.dispose()
      floorMaterial.dispose()
      ceilingGeometry.dispose()
      if (ceilingMaterial.map) ceilingMaterial.map.dispose()
      ceilingMaterial.dispose()
      leftWallGeometry.dispose()
      rightWallGeometry.dispose()
      if (wallMaterial.map) wallMaterial.map.dispose()
      wallMaterial.dispose()
      scene.remove(selectionLight)
      scene.remove(selectionLightTarget)
      scene.remove(selectionTopLight)
      renderer.dispose()

      if (renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement)
      }
    }
  }, [])

  const showCenterModal = Boolean(modalInfo)

  return (
    <>
      <div className="info">
        <h3>Endless Hallway Gallery</h3>
        <p>Explore the gallery and admire the artwork on the walls.</p>
      </div>

      <pre className="debug-hud" ref={debugHudRef} aria-live="polite" />

      <div id="motionBlur" ref={motionBlurRef} />
      <div
        className={`cursor-light-mask ${showCenterModal ? 'cursor-light-mask--focused' : ''}`}
        ref={cursorLightRef}
        aria-hidden="true"
      />

      {showCenterModal ? (
        <>
          <div className="painting-modal-backdrop" aria-hidden="true" onClick={() => setModalInfo(null)} />
          <section className="painting-modal" role="dialog" aria-label="Selected painting">
            <div className="painting-modal__content" aria-live="polite">
              <p><strong>Name:</strong> {modalInfo.title}</p>
              <p><strong>Author:</strong> {modalInfo.artist}</p>
              <p><strong>Year:</strong> {modalInfo.year || 'Unknown'}</p>
              <p><strong>Style:</strong> {modalInfo.style || 'Unknown'}</p>
              <p><strong>Description:</strong> {modalInfo.description}</p>
            </div>

            <div className="painting-modal__actions">
              <button type="button" className="painting-modal__close" onClick={() => setModalInfo(null)}>
                Close
              </button>
            </div>
          </section>
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
        <button
          type="button"
          className="turnLeft"
          onPointerDown={(e) => handleControlPointerDown('q', e)}
          onMouseDown={(e) => handleControlMouseDown('q', e)}
          onTouchStart={(e) => handleControlTouchStart('q', e)}
          onClick={(e) => handleControlClick('q', e)}
        >
          {'<- Turn Left'}
        </button>
        <button
          type="button"
          className="forward"
          onPointerDown={(e) => handleControlPointerDown('w', e)}
          onMouseDown={(e) => handleControlMouseDown('w', e)}
          onTouchStart={(e) => handleControlTouchStart('w', e)}
          onClick={(e) => handleControlClick('w', e)}
        >
          {'^ Forward'}
        </button>
        <button
          type="button"
          className="turnRight"
          onPointerDown={(e) => handleControlPointerDown('e', e)}
          onMouseDown={(e) => handleControlMouseDown('e', e)}
          onTouchStart={(e) => handleControlTouchStart('e', e)}
          onClick={(e) => handleControlClick('e', e)}
        >
          {'Turn Right ->'}
        </button>
        <button
          type="button"
          className="backward"
          onPointerDown={(e) => handleControlPointerDown('s', e)}
          onMouseDown={(e) => handleControlMouseDown('s', e)}
          onTouchStart={(e) => handleControlTouchStart('s', e)}
          onClick={(e) => handleControlClick('s', e)}
        >
          {'v Backward'}
        </button>
      </div>

      <div id="canvas" ref={mountRef} />
    </>
  )
}

export default App