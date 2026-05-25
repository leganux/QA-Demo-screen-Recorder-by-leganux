# Browser Agent Recorder (MVP)

Agente de navegador en **Node.js + Playwright + OpenAI** para ejecutar tareas en sitios web y grabar el flujo completo en video.

Flujo principal:

**ver pantalla → decidir acción (IA) → ejecutar acción → grabar → repetir → terminar**

---

## 1) Instalación

```bash
npm install
```

Instala navegadores de Playwright (si es primera vez):

```bash
npx playwright install chromium
```

---

## 2) Configuración de variables de entorno

1. Copia el archivo de ejemplo:

```bash
cp .env.example .env
```

2. Edita `.env` y configura al menos:

```env
OPENAI_API_KEY=tu_api_key
AI_MODEL=gpt-4o-mini
MAX_STEPS=30
OUTPUT_DIR=./videos
SCREENSHOT_DIR=./screenshots
```

Variables disponibles:

- `OPENAI_API_KEY`: API key de OpenAI.
- `OPENAI_BASE_URL`: opcional, para proveedor compatible.
- `AI_MODEL`: modelo de chat para decidir acciones.
- `MAX_STEPS`: máximo de iteraciones para evitar loops.
- `OUTPUT_DIR`: carpeta de videos finales.
- `SCREENSHOT_DIR`: carpeta de screenshots temporales por paso.
- `SESSION_DIR`: carpeta donde se guarda la sesión/cookies/cache del navegador para reutilizar login.
- `LOG_DIR`: carpeta para logs de errores del navegador.
- `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT`: viewport (ej. 1366x768 o 1920x1080).
- `AI_STATE_TEXT_LIMIT`: límite de texto visible enviado a IA.
- `ENABLE_HUMAN_CURSOR`: activa/desactiva movimiento visual de cursor tipo humano.
- `ENABLE_BROWSER_ERROR_LOG`: activa/desactiva archivo de log de errores de navegador.
- `ACTION_MAX_RETRIES`: reintentos de una acción cuando el DOM cambia por navegación/refresh.
- `OBSERVE_RETRIES`: reintentos al capturar estado de página en transición.
- `RETRY_BASE_WAIT_MS`: espera base incremental entre reintentos.

---

## 3) Ejecución

### Opción directa

```bash
node src/app.js --url="https://mi-sistema.com" --prompt="Registra una persona nueva con nombre Juan Pérez, correo juan.demo@example.com y teléfono 7711234567"
```

También puedes ejecutarlo sin `--url` y/o sin `--prompt`; el programa te los pedirá en consola:

```bash
node src/app.js
```

Para forzar borrado de sesión/caché guardada en esa ejecución:

```bash
node src/app.js --url="https://mi-sistema.com" --prompt="Registra una persona demo" --clear-cache=true
```

Para controlar cursor humano en una ejecución:

```bash
node src/app.js --url="https://mi-sistema.com" --prompt="Registra una persona demo" --human-cursor=true
```

Para activar/desactivar log de errores de navegador en una ejecución:

```bash
node src/app.js --url="https://mi-sistema.com" --prompt="Registra una persona demo" --browser-error-log=true
```

### Con script npm

```bash
npm run start -- --url="https://mi-sistema.com" --prompt="Crea un evento de boda demo"
```

---

## 4) ¿Dónde quedan los videos?

En la carpeta configurada por `OUTPUT_DIR` (por defecto `./videos`), por ejemplo:

```text
./videos/tutorial-2026-05-15-143000.webm
```

Además, en `SCREENSHOT_DIR` (por defecto `./screenshots`) se generan capturas de cada paso y capturas de error.

Si `ENABLE_BROWSER_ERROR_LOG=true`, también se crea un archivo en `LOG_DIR` con:

- `console.error` del navegador
- errores runtime (`pageerror`)
- requests fallidos (`requestfailed`)
- respuestas HTTP con estatus 4xx/5xx

---

## 5) Arquitectura del MVP

```text
/browser-agent-recorder
├── src
│   ├── app.js        # Entrada CLI y orquestación
│   ├── browser.js    # Inicio/cierre de Playwright y contexto con grabación
│   ├── agent.js      # Loop principal observar→IA→actuar
│   ├── actions.js    # resolverSelector + ejecución de acciones
│   ├── observer.js   # Estado de página + screenshot + análisis con Cheerio
│   ├── recorder.js   # manejo de directorios y nombre final del video
│   ├── config.js     # variables de entorno y defaults
│   └── utils.js      # utilidades generales
├── videos
├── screenshots
├── .env.example
├── package.json
└── README.md
```

---

## 6) Cómo decide y actúa

En cada iteración el observador extrae:

- URL actual
- título
- texto visible principal
- formularios detectados
- botones visibles
- enlaces visibles
- campos `input/select/textarea`
- ruta de screenshot

La IA recibe el objetivo original + estado actual y responde **JSON estricto** con la siguiente acción:

```json
{
  "thought": "explicación breve",
  "action": "click | type | select | check | uncheck | scroll | wait | goto | finish | fail | upload",
  "selector": "selector CSS o texto localizable",
  "value": "valor opcional",
  "reason": "por qué ayuda"
}
```

---

## 7) Selectores soportados

`resolverSelector` soporta:

- CSS normal (`input[name='email']`)
- `text=Guardar`
- `role=button:Guardar`
- `label=Correo electrónico`
- fallback por texto similar en botones/links/inputs
- fallback adicional usando **Cheerio** (análisis DOM tipo jQuery) para sugerir/selectores alternativos

---

## 8) Protección contra errores

- Si un elemento no se encuentra: captura screenshot y reintenta con nueva decisión de IA.
- Si la IA propone una acción con selector faltante o inválido, el agente la omite y continúa intentando.
- Si la IA propone una acción que requiere valor y no lo trae, el agente la omite y continúa intentando.
- Reintenta acciones cuando la página está cambiando (navegación/DOM refresh) para no detenerse por errores transitorios.
- Reintenta observación del estado de página cuando el contenido está en transición.
- Si la IA repite la misma acción más de 3 veces: detiene ejecución.
- Si supera `MAX_STEPS` (por defecto 30): finaliza con error controlado.
- Manejo básico de modales y `dialog` (alert/confirm/prompt).
- Esperas con `waitForLoadState` tras acciones relevantes.

---

## 9) Limitaciones del agente (MVP)

- Puede fallar en interfaces muy dinámicas sin buenos selectores.
- Captchas, MFA/2FA, SSO corporativo y políticas anti-bot pueden bloquearlo.
- No incluye visión por OCR; se basa en DOM y texto de elementos.
- El fallback de Cheerio ayuda a decidir selectores, pero no reemplaza buenas etiquetas accesibles en tu UI.

---

## 10) Recomendaciones (sitios propios)

Para mejores resultados en ERPs, CRMs, dashboards y sistemas admin:

- Agrega `id`, `name` o `data-testid` consistentes.
- Usa labels claros en formularios.
- Evita textos ambiguos en botones (ej. múltiples “Guardar”).
- Mantén patrones estables en menús, modales, tabs y tablas.

---

## 11) Advertencia importante

Úsalo preferentemente en sistemas propios o ambientes de prueba.

En sitios de terceros puede fallar por captchas, autenticación, permisos, layouts dinámicos o restricciones anti-automatización.

No uses datos reales sensibles: trabaja con datos demo.
