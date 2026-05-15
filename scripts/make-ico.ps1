$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PngPath = Join-Path $ProjectDir 'public\eum-photo-icon.png'
if (-not (Test-Path $PngPath)) {
    $PngPath = Join-Path $ProjectDir 'public\eum-logo.png'
}
$Targets = @(
    (Join-Path $ProjectDir 'public\icon.ico'),
    (Join-Path $ProjectDir 'public\eum-logo.ico')
)
$Sizes = @(16, 24, 32, 48, 64, 128, 256)

if (-not (Test-Path $PngPath)) {
    Write-Error "Source PNG not found: $PngPath"
    exit 1
}

function Convert-BitmapToIcoDibBytes {
    param([System.Drawing.Bitmap]$Bitmap)

    $width = $Bitmap.Width
    $height = $Bitmap.Height
    $stride = $width * 4
    $xorBytes = New-Object byte[] ($stride * $height)

    for ($y = 0; $y -lt $height; $y++) {
        $destY = $height - 1 - $y
        for ($x = 0; $x -lt $width; $x++) {
            $color = $Bitmap.GetPixel($x, $y)
            $index = ($destY * $stride) + ($x * 4)
            $xorBytes[$index] = $color.B
            $xorBytes[$index + 1] = $color.G
            $xorBytes[$index + 2] = $color.R
            $xorBytes[$index + 3] = $color.A
        }
    }

    $maskStride = [int]([Math]::Ceiling($width / 32.0) * 4)
    $maskBytes = New-Object byte[] ($maskStride * $height)

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([UInt32]40)                                # BITMAPINFOHEADER size
    $writer.Write([Int32]$width)
    $writer.Write([Int32]($height * 2))                       # XOR + AND mask height
    $writer.Write([UInt16]1)                                  # planes
    $writer.Write([UInt16]32)                                 # bit depth
    $writer.Write([UInt32]0)                                  # BI_RGB
    $writer.Write([UInt32]($xorBytes.Length + $maskBytes.Length))
    $writer.Write([Int32]0)
    $writer.Write([Int32]0)
    $writer.Write([UInt32]0)
    $writer.Write([UInt32]0)
    $writer.Write($xorBytes)
    $writer.Write($maskBytes)
    $writer.Flush()

    $bytes = $stream.ToArray()
    $writer.Dispose()
    $stream.Dispose()
    return ,$bytes
}

Write-Host "[icon:make] building DIB-based multi-resolution ICO from $PngPath" -ForegroundColor Cyan

$source = [System.Drawing.Image]::FromFile($PngPath)
try {
    $entries = @()
    foreach ($size in $Sizes) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.DrawImage($source, 0, 0, $size, $size)
        $graphics.Dispose()

        $entries += [pscustomobject]@{
            Size = $size
            Bytes = [byte[]](Convert-BitmapToIcoDibBytes $bitmap)
        }
        $bitmap.Dispose()
    }
} finally {
    $source.Dispose()
}

foreach ($target in $Targets) {
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)

    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$entries.Count)

    $offset = 6 + (16 * $entries.Count)
    foreach ($entry in $entries) {
        $dimension = if ($entry.Size -eq 256) { [byte]0 } else { [byte]$entry.Size }
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$entry.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $entry.Bytes.Length
    }

    foreach ($entry in $entries) {
        $writer.Write($entry.Bytes)
    }

    $writer.Flush()
    [System.IO.File]::WriteAllBytes($target, $stream.ToArray())
    $writer.Dispose()
    $stream.Dispose()

    $item = Get-Item $target
    Write-Host "[icon:make] wrote $($item.FullName) ($($item.Length) bytes)" -ForegroundColor Green
}
