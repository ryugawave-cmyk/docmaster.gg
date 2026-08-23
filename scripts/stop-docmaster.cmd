@echo off
rem Explicitly stop DocMaster and prevent it from auto-starting again.
schtasks /End /TN "DocMaster" >nul 2>&1
schtasks /Change /TN "DocMaster" /DISABLE >nul 2>&1
echo DocMaster stopped and autostart disabled.
echo Run start-docmaster.cmd to start it again.
