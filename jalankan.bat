@echo off
rem Jalankan scanner saham lokal lalu buka di browser. Tutup jendela ini untuk berhenti.
cd /d "%~dp0"
".venv\Scripts\python.exe" server.py
