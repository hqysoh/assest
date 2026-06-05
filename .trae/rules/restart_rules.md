# 服务重启规则

## 端口分配
- **8188**: ComfyUI — **绝不杀死此进程**
- **8000**: 前端 (python -m http.server)
- **8765**: 后端 (backend.py)

## 如何启动（一键命令）

直接复制下面一整行到终端执行：

```powershell
netstat -ano | findstr ":8765 " | findstr LISTENING | ForEach-Object { $p = (-split $_)[-1]; taskkill /F /PID $p 2>$null }; netstat -ano | findstr ":8000 " | findstr LISTENING | ForEach-Object { $p = (-split $_)[-1]; taskkill /F /PID $p 2>$null }; Start-Process python -ArgumentList "f:\Desktop\资产库\assest_html\backend.py" -WindowStyle Minimized; Start-Process powershell -ArgumentList "-NoExit","-Command","cd 'f:\Desktop\资产库\assest_html'; python -m http.server 8000" -WindowStyle Minimized
```

或直接双击运行：**`f:\Desktop\资产库\assest_html\启动资产库.bat`**

## 分步命令

```powershell
# 1. 杀掉占用 8765 端口的进程
netstat -ano | findstr ":8765 " | findstr LISTENING | ForEach-Object { $p = (-split $_)[-1]; taskkill /F /PID $p 2>$null }

# 2. 杀掉占用 8000 端口的进程
netstat -ano | findstr ":8000 " | findstr LISTENING | ForEach-Object { $p = (-split $_)[-1]; taskkill /F /PID $p 2>$null }

# 3. 启动后端 (端口 8765)
Start-Process python -ArgumentList "f:\Desktop\资产库\assest_html\backend.py" -WindowStyle Minimized

# 4. 启动前端 (端口 8000)
Start-Process powershell -ArgumentList "-NoExit","-Command","cd 'f:\Desktop\资产库\assest_html'; python -m http.server 8000" -WindowStyle Minimized
```

## 访问地址
- 前端: **http://localhost:8000**
- 后端 API: **http://localhost:8765**

## 验证服务是否运行
```powershell
netstat -ano | findstr ":8765 " | findstr LISTENING
netstat -ano | findstr ":8000 " | findstr LISTENING
```

## 绝对禁止
- ❌ `taskkill /F /IM python.exe` — 会杀死 ComfyUI (8188)
- ❌ `Get-Process python | Stop-Process -Force` — 会杀死 ComfyUI
- ❌ 任何不区分端口的批量杀进程操作
