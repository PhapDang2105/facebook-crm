@echo off
set "PROJECT_ROOT=%~dp0"
set "PATH=%PROJECT_ROOT%tools\node;%PATH%"
"%PROJECT_ROOT%tools\node\node.exe" "%PROJECT_ROOT%tools\graphcode-src\bin\graphcode.mjs" %*

