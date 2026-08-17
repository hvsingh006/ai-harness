param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a folder to approve for this AI Harness Project Space'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::WriteLine(($dialog.SelectedPath | ConvertTo-Json -Compress))
  exit 0
}
exit 3
