#!/bin/bash

# Script de instalación rápida para PodoClinic
# Ejecuta: chmod +x setup.sh && ./setup.sh

echo "🦶 PodoClinic - Instalación Rápida"
echo "=================================="

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js no está instalado"
    echo "📥 Descargalo desde: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js detectado: $(node --version)"

# Verificar npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm no está instalado"
    exit 1
fi

echo "✅ npm detectado: $(npm --version)"

# Instalar dependencias
echo ""
echo "📦 Instalando dependencias..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencias instaladas"
else
    echo "❌ Error en instalación de dependencias"
    exit 1
fi

# Verificar MySQL
echo ""
echo "🗄️  Verificando MySQL..."
if ! command -v mysql &> /dev/null; then
    echo "⚠️  MySQL no encontrado en PATH"
    echo "📝 Importa database.sql manualmente:"
    echo "   mysql -u root -p podologia_db < database.sql"
else
    echo "✅ MySQL detectado"
fi

# Crear archivo .env si no existe
if [ ! -f .env ]; then
    echo ""
    echo "📝 Creando archivo .env..."
    cat > .env << EOF
PORT=3001
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=podologia_db
JWT_SECRET=tu_secreto_seguro_aqui_2026
NODE_ENV=development
EOF
    echo "✅ Archivo .env creado"
else
    echo "✅ Archivo .env ya existe"
fi

echo ""
echo "=================================="
echo "✅ ¡Instalación completada!"
echo ""
echo "🚀 Para iniciar:"
echo "   npm start"
echo ""
echo "📝 Luego abre: http://localhost:3001"
echo ""
echo "📊 Primero importa la BD:"
echo "   mysql -u root -p podologia_db < database.sql"
echo "=================================="
