param(
    [int]$Size = 1024,
    [int]$CornerRadius = 180,
    [int]$BorderWidth = 16,
    [string]$OutputName = 'eum-photo-icon.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$SourcePng = Join-Path $ProjectDir 'public\eum-logo.png'
$OutputPath = Join-Path $ProjectDir "public\$OutputName"

if (-not (Test-Path $SourcePng)) {
    throw "Source logo not found: $SourcePng"
}

$bitmap = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedRectPath {
    param([System.Drawing.RectangleF]$Rect, [single]$Radius)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$inset = 8
$rect = New-Object System.Drawing.RectangleF($inset, $inset, ($Size - $inset * 2), ($Size - $inset * 2))
$roundedPath = New-RoundedRectPath -Rect $rect -Radius $CornerRadius

$gradColorTop = [System.Drawing.Color]::FromArgb(255, 30, 22, 56)
$gradColorBottom = [System.Drawing.Color]::FromArgb(255, 8, 6, 18)

$gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF(0, $Size)),
    $gradColorTop,
    $gradColorBottom
)

$g.FillPath($gradBrush, $roundedPath)
$gradBrush.Dispose()

$highlightRect = New-Object System.Drawing.RectangleF(0, 0, [single]$Size, [single]($Size * 0.5))
$highlightBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $highlightRect,
    [System.Drawing.Color]::FromArgb(48, 212, 175, 55),
    [System.Drawing.Color]::FromArgb(0, 212, 175, 55),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
)
$g.SetClip($roundedPath)
$g.FillRectangle($highlightBrush, 0, 0, $Size, [int]($Size * 0.5))
$g.ResetClip()
$highlightBrush.Dispose()

$borderColor = [System.Drawing.Color]::FromArgb(255, 212, 175, 55)
$pen = New-Object System.Drawing.Pen($borderColor, $BorderWidth)
$pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
$g.DrawPath($pen, $roundedPath)
$pen.Dispose()

$source = [System.Drawing.Image]::FromFile($SourcePng)
try {
    $logoFraction = 0.68
    $logoSize = [int]($Size * $logoFraction)
    $logoX = [int](($Size - $logoSize) / 2)
    $logoY = [int](($Size - $logoSize) / 2)
    $g.DrawImage($source, $logoX, $logoY, $logoSize, $logoSize)
} finally {
    $source.Dispose()
}

$roundedPath.Dispose()
$g.Dispose()

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$item = Get-Item $OutputPath
Write-Host "[icon-png] wrote $($item.FullName) ($($item.Length) bytes, ${Size}x${Size})" -ForegroundColor Green
