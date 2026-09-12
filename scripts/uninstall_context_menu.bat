@echo off
chcp 65001 >nul
echo ========================================================================
echo   Đang gỡ bỏ "Open with PDF Craft" khỏi Menu chuột phải Windows...
echo ========================================================================

cd /d "%~dp0\.."
if exist "PDFCraft.exe" (
    PDFCraft.exe unregister-menu
) else (
    echo [LỖI] Không tìm thấy tệp PDFCraft.exe trong thư mục gốc!
    pause
    exit /b 1
)

echo.
echo Nhấn phím bất kỳ để đóng cửa sổ này...
pause >nul
