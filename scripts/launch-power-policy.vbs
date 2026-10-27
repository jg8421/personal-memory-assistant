Option Explicit
Dim shell,fs,root,ps,cmd
Set shell=CreateObject("WScript.Shell")
Set fs=CreateObject("Scripting.FileSystemObject")
root=fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
ps=shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd="""" & ps & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & root & "\scripts\capture-power-policy.ps1"" -InstallRoot """ & root & """"
shell.Run cmd,0,False