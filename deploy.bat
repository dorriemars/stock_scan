@echo off
rem Deploy scanner (halaman + API Python) ke Vercel. Perlu `vercel login` sekali.
cd /d "%~dp0app"
vercel deploy --prod --yes
