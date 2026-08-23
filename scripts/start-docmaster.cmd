@echo off
rem Start DocMaster in the background (and re-enable autostart at logon).
schtasks /Change /TN "DocMaster" /ENABLE >nul 2>&1
schtasks /Run /TN "DocMaster" >nul 2>&1
echo DocMaster is starting in the background on http://localhost:3210
echo (no window will appear; it keeps running until you run stop-docmaster.cmd)
