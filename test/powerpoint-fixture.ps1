# Generate an isolated two-slide fixture in both supported formats.
param([string]$Directory)
$ErrorActionPreference = 'Stop'
$existing = @(Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
$deck = $null
try {
    $deck = $app.Presentations.Add(0)
    for ($i = 1; $i -le 2; $i++) {
        $slide = $deck.Slides.Add($i, 12)
        $shape = $slide.Shapes.AddTextbox(1, 60, 80, 600, 100)
        $shape.TextFrame.TextRange.Text = "PRT conversion fixture - slide $i"
        $shape.TextFrame.TextRange.Font.Size = 28
    }
    $deck.SaveAs((Join-Path $Directory 'fixture.pptx'), 24)
    $deck.SaveAs((Join-Path $Directory 'fixture.ppt'), 1)
} finally {
    if ($null -ne $deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck) }
    if ($existing.Count -eq 0 -and $app.Presentations.Count -eq 0) { $app.Quit() }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
}
