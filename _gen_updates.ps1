$src = "c:\Users\emine\gjshackathon\Artworks_rows.sql"
$out = "c:\Users\emine\gjshackathon\edit.sql"

$content = Get-Content -Raw $src
$pattern = "\('(?<id>\d+)',\s*'(?<created>(?:''|[^'])*)',\s*'(?<name>(?:''|[^'])*)',\s*'(?<author>(?:''|[^'])*)',\s*'(?<desc>(?:''|[^'])*)',\s*null\)"
$matches = [regex]::Matches($content, $pattern)

function Translate-ToCzech([string]$text) {
    $t = $text
    $replacements = @(
        @('Post-Impressionist','Postimpresionistický'),
        @('Impressionist','Impresionistický'),
        @('Abstract expressionist','Abstraktně expresionistický'),
        @('Abstract','Abstraktní'),
        @('Cubist','Kubistický'),
        @('Fauvist','Fauvistický'),
        @('Renaissance','Renesanční'),
        @('Baroque','Barokní'),
        @('Dutch Golden Age','Nizozemský ze zlatého věku'),
        @('Symbolist','Symbolistický'),
        @('still life','zátiší'),
        @('cityscape','městská scenérie'),
        @('seascape','mořská krajina'),
        @('landscape study','krajinářská studie'),
        @('landscape painting','krajinomalba'),
        @('study painting','studijní obraz'),
        @('portrait painting','portrétní obraz'),
        @('religious painting','náboženský obraz'),
        @('genre painting','žánrový obraz'),
        @('painting','obraz'),
        @('reported stolen from','nahlášen jako odcizený z'),
        @('stolen briefly during','krátce odcizen během'),
        @('stolen during','ukraden během'),
        @('stolen from','ukraden z'),
        @('stolen in','ukraden v'),
        @('taken during','odcizen během'),
        @('taken from','odcizen z'),
        @('disappeared from','zmizel z'),
        @('disappeared after','zmizel po'),
        @('missing after','pohřešován po'),
        @('has been missing since','je pohřešován od'),
        @('later recovered by police','později nalezen policií'),
        @('later recovered by authorities','později nalezen úřady'),
        @('later recovered','později nalezen'),
        @('later rediscovered','později znovu objeven'),
        @('during a museum robbery','během loupeže v muzeu'),
        @('during a museum theft','během krádeže v muzeu'),
        @('during a gallery burglary','během vloupání do galerie'),
        @('during a burglary','během vloupání'),
        @('during transport between exhibitions','během přepravy mezi výstavami'),
        @('during transport','během přepravy'),
        @('during wartime art theft','během válečné krádeže umění'),
        @('during wartime looting','během válečného rabování'),
        @('museum storage room','muzejního depozitáře'),
        @('gallery storage facility','galerijního depozitáře'),
        @('private collection','soukromé sbírky'),
        @('private residence','soukromé rezidence'),
        @('collector''s home','domova sběratele')
    )

    foreach ($pair in $replacements) {
        $t = [regex]::Replace($t, [regex]::Escape($pair[0]), $pair[1], 'IgnoreCase')
    }

    $t = [regex]::Replace($t, ' in ([0-9]{4})\.', ' v roce $1.')
    $t = [regex]::Replace($t, '^Another Monet', 'Další Monetův obraz')
    $t = [regex]::Replace($t, '\s{2,}', ' ').Trim()

    if ($t.Length -gt 0) {
        $t = $t.Substring(0,1).ToUpper() + $t.Substring(1)
    }

    return $t
}

$lines = @()
$lines += "-- Per-artwork updates for rows missing description_cs"
$lines += ""

foreach ($m in $matches) {
    $name = $m.Groups['name'].Value -replace "''","'"
    $desc = $m.Groups['desc'].Value -replace "''","'"
    $cs = Translate-ToCzech $desc

    $nameSql = $name -replace "'","''"
    $csSql = $cs -replace "'","''"

    $lines += 'UPDATE "Artworks"'
    $lines += "SET description_cs = '$csSql'"
    $lines += "WHERE artwork_name = '$nameSql' AND description_cs IS NULL;"
    $lines += ""
}

Set-Content -Path $out -Value $lines -Encoding UTF8
Write-Host ("Generated updates: " + $matches.Count)
