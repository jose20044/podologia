FROM node:18-alpine

WORKDIR /app

# Instalar dependencias primero (mejor cacheo)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
