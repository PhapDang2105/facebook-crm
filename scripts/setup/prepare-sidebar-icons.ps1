param(
    [Parameter(Mandatory = $true)] [string]$StrategySource,
    [Parameter(Mandatory = $true)] [string]$MessageSource
)

Add-Type -AssemblyName System.Drawing

$iconDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\web\assets\icons'))

# Preserve the exact supplied artwork and recolor only the dark fill inside the megaphone.
$strategy = [System.Drawing.Bitmap]::FromFile($StrategySource)
try {
    $strategyOutput = New-Object System.Drawing.Bitmap($strategy.Width, $strategy.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($strategyOutput)
    try { $graphics.DrawImageUnscaled($strategy, 0, 0) } finally { $graphics.Dispose() }

    $cone = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cone.AddPolygon([System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(137, 72),
        [System.Drawing.Point]::new(207, 23),
        [System.Drawing.Point]::new(243, 153),
        [System.Drawing.Point]::new(144, 123)
    ))
    $rear = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rear.AddPolygon([System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(94, 79),
        [System.Drawing.Point]::new(139, 70),
        [System.Drawing.Point]::new(148, 125),
        [System.Drawing.Point]::new(104, 130)
    ))

    for ($y = 0; $y -lt $strategyOutput.Height; $y++) {
        for ($x = 0; $x -lt $strategyOutput.Width; $x++) {
            if (-not ($cone.IsVisible($x, $y) -or $rear.IsVisible($x, $y))) { continue }
            $pixel = $strategyOutput.GetPixel($x, $y)
            if ($pixel.A -gt 0 -and $pixel.R -lt 70 -and $pixel.G -lt 70 -and $pixel.B -lt 70) {
                $shade = [Math]::Min(1.0, [Math]::Max(0.72, ($pixel.R + 45) / 80.0))
                $red = [int](255 * $shade)
                $green = [int](138 * $shade)
                $strategyOutput.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($pixel.A, $red, $green, 0))
            }
        }
    }

    $cone.Dispose()
    $rear.Dispose()
    $strategyOutput.Save((Join-Path $iconDirectory 'strategy-logo-orange.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $strategyOutput.Dispose()
}
finally {
    $strategy.Dispose()
}

# Remove only the light background connected to the canvas edge. Enclosed white areas stay intact.
$message = [System.Drawing.Bitmap]::FromFile($MessageSource)
try {
    $messageOutput = New-Object System.Drawing.Bitmap($message.Width, $message.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($messageOutput)
    try { $graphics.DrawImageUnscaled($message, 0, 0) } finally { $graphics.Dispose() }

    $visited = New-Object 'bool[]' ($message.Width * $message.Height)
    $queue = New-Object 'System.Collections.Generic.Queue[int]'

    function Add-Light-Pixel([int]$x, [int]$y) {
        $index = $y * $message.Width + $x
        if ($visited[$index]) { return }
        $visited[$index] = $true
        $pixel = $messageOutput.GetPixel($x, $y)
        $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
        $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
        if ($pixel.A -eq 0 -or ($minimum -ge 220 -and ($maximum - $minimum) -le 18)) {
            $queue.Enqueue($index)
        }
    }

    for ($x = 0; $x -lt $message.Width; $x++) { Add-Light-Pixel $x 0; Add-Light-Pixel $x ($message.Height - 1) }
    for ($y = 1; $y -lt ($message.Height - 1); $y++) { Add-Light-Pixel 0 $y; Add-Light-Pixel ($message.Width - 1) $y }

    while ($queue.Count -gt 0) {
        $index = $queue.Dequeue()
        $x = $index % $message.Width
        $y = [Math]::Floor($index / $message.Width)
        $messageOutput.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
        if ($x -gt 0) { Add-Light-Pixel ($x - 1) $y }
        if ($x + 1 -lt $message.Width) { Add-Light-Pixel ($x + 1) $y }
        if ($y -gt 0) { Add-Light-Pixel $x ($y - 1) }
        if ($y + 1 -lt $message.Height) { Add-Light-Pixel $x ($y + 1) }
    }

    $messageOutput.Save((Join-Path $iconDirectory 'message-logo-transparent.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $messageOutput.Dispose()
}
finally {
    $message.Dispose()
}
