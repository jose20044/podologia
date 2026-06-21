# PodoClinic — Arranque en local (Docker)

Esta guía levanta **toda la app (Node + MySQL)** con un solo comando.
No necesitas instalar Node ni MySQL en tu PC, solo **Docker Desktop**.

## 1. Requisitos

- Docker Desktop instalado y **en ejecución** (ícono de la ballena activo).

## 2. Levantar todo

Desde la carpeta `podologia/`:

```bash
docker compose up --build
```

La primera vez tarda (descarga imágenes y compila). Cuando veas:

```
🦶 PodoClinic corriendo en http://localhost:3001
```

ya está listo.

## 3. Abrir la app

- Portal pacientes (página principal): http://localhost:3001/
- Panel médico (privado):              http://localhost:3001/medico
- Health check:                        http://localhost:3001/health

## 4. Crear el primer usuario médico

Por seguridad, el registro público **solo crea pacientes**. Para crear un **médico**
hay que enviar la cabecera `x-setup-token` con el valor de `SETUP_TOKEN` (en `.env`):

```powershell
$tok = (Get-Content .env | Select-String '^SETUP_TOKEN=').ToString().Split('=')[1]
Invoke-WebRequest -Method Post http://localhost:3001/api/auth/register `
  -ContentType 'application/json' `
  -Headers @{ 'x-setup-token' = $tok } `
  -Body '{"name":"Dr. Prueba","email":"medico@clinic.com","password":"medico123","role":"doctor"}'
```

Luego entra en http://localhost:3001/medico con ese correo.

## 5. Comandos útiles

```bash
docker compose up -d          # levantar en segundo plano
docker compose logs -f app    # ver logs de la app
docker compose down           # detener (conserva los datos)
docker compose down -v        # detener y BORRAR la base de datos
docker compose up --build     # reconstruir tras cambiar dependencias
```

Los datos de MySQL persisten en el volumen `mysql_data` entre reinicios.

## Notas

- Las variables están en `.env` (no se sube a GitHub).
- `JWT_SECRET` ya viene fijo en `.env`; mantenlo estable o las sesiones se cerrarán.
- Si editas `server.js`, reinicia con `docker compose restart app`.
