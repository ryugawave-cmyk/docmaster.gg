' DocMaster background launcher + keep-alive.
' Runs the Node server with NO visible console window (window style 0) and
' relaunches it a few seconds after any exit, so a crash auto-recovers. The
' Scheduled Task that runs this stays "Running" for the whole lifetime, so
' stopping/ending the task cleanly stops the server too. The working directory
' is set first so dotenv finds .env (PORT=3210), exactly like `npm start`.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\DOCMASTER.gg"
Do
  sh.Run """C:\Program Files\nodejs\node.exe"" ""src\server.js""", 0, True
  WScript.Sleep 3000
Loop
