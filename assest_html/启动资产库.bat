@echo off
title 资产库 - 全栈服务
color 0B
echo ========================================
echo   资产库管理系统
echo ========================================
echo.
echo   启动命令说明:
echo   后端: python assest_html\backend.pyassest_html\backend.pyassest_html\backend.pyassest_html\backend.pyassest_html\backend.py        (端口 8765 - Claude Code API)
echo   前端: python -m http.server 8000 (端口 8000 - Web 前端)
echo   注意: 不会影响 ComfyUI (端口 8188)
echo ========================================
echo.
echo   正在停止旧服务 (仅8765和8000端口)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765 " ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 " ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul
echo.
echo   正在启动后端服务 (8765)...
start "资产库-后端" /MIN cmd /c "cd /d %~dp0 && python backend.py"
echo   后端服务已启动 [http://localhost:8765]
echo.
echo   正在启动前端服务 (8000)...
start "资产库-前端" /MIN cmd /c "cd /d %~dp0 && python -m http.server 8000"
echo   前端服务已启动 [http://localhost:8000]
echo.
echo ========================================
echo   全部服务已启动！
echo   浏览器访问: http://localhost:8000
echo ========================================
echo.
timeout /t 3 >nul
exit
