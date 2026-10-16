# Bitácora Spotting (beta)

Web para que cada spotter lleve el registro de sus fotos. Los RAW se leen **en el navegador**:
no se suben los originales, solo una miniatura (~30 KB) de la foto elegida de cada ráfaga.

- `index.html`, `styles.css`, `js/app.js` — la app (HTML + JS sin compilación).
- `js/raw.js` — lectura de NEF/CR2/CR3/ARW/DNG/RAF: vista previa embebida, hora EXIF, ráfagas, nitidez y encuadre.
- `js/ia.js` + `api/identificar.js` — v0.2: identificación con IA (matrícula, tipo y operador). La web manda la
  foto elegida reducida y un recorte del avión; el servidor (función de Vercel) llama a la IA con la clave guardada en Vercel.
- `supabase/schema.sql` — tablas, permisos (cada usuario solo ve lo suyo) y almacén de miniaturas.
- `supabase/v0.2.sql` — lo nuevo de la v0.2 (columna `ia` y tabla `ai_uso` para el límite diario).

## Puesta en marcha
1. Supabase → SQL Editor → pegar `supabase/schema.sql` → Run.
2. Supabase → Authentication → Sign In / Providers → Email → desactivar «Confirm email» (beta).
3. Vercel → Add New → Project → importar este repositorio → Deploy (sin configuración: es estático).
4. Supabase → Authentication → URL Configuration → Site URL = la dirección de Vercel.

## Activar la IA (v0.2)
1. Supabase → SQL Editor → pegar `supabase/v0.2.sql` → Run.
2. Crear una clave en console.anthropic.com (API Keys) con saldo cargado.
3. Vercel → proyecto → Settings → Environment Variables → `ANTHROPIC_API_KEY` = la clave → Save → Deployments → Redeploy.
   Opcionales: `AI_MODEL_LECTURA` (lee la foto; por defecto `claude-haiku-5-5`), `AI_MODEL_REVISION` (repasa las lecturas
   dudosas; por defecto `claude-sonnet-5-5`; `AI_REVISION=0` la desactiva), `AI_LIMITE_DIA` (por defecto 400 ráfagas por usuario y día; `0` = sin límite), `AI_SIN_LIMITE` (correos sin límite, separados por comas),
   `GEMINI_API_KEY` + `AI_PROVIDER=gemini` para probar Gemini.
Sin clave, la web funciona igual que la v0.1 (registro a mano).

**Verificación de matrícula (v0.2.1):** cuando la IA lee una matrícula completa, el servidor abre sus fichas en
JetPhotos, airport-data y Planespotters (solo esas webs) y corrige tipo ICAO y operador. Sin cargo extra por consulta,
solo los tokens leídos. Opcionales: `AI_MODEL_VERIF` (por defecto `claude-haiku-5-5`; si no admite la herramienta se usa
`AI_MODEL`) y `AI_VERIFICAR=0` para desactivarla.

**Ahorro (v0.2.2):** cada matrícula se busca una sola vez por sesión (las ráfagas del mismo avión esperan a la misma
búsqueda) y las matrículas ya revisadas en tu bitácora no se buscan. Al terminar, las ráfagas con la misma matrícula
y día se unen solas.

Navegadores: Chrome, Edge, Firefox o Safari recientes en ordenador.

**Prueba Haiku vs Sonnet:** abre la web con `?comparar` al final de la dirección. Cada ráfaga se lee con los dos
modelos, la barra de IA cuenta en cuántas coinciden las matrículas y «Ver diferencias» salta a las que no.
Cuesta unas 20 veces más por ráfaga: úsalo solo con una carpeta de prueba.

**Unión por avión (v0.3):** al terminar la identificación se juntan en una sola entrada todas las ráfagas del mismo
avión de la carpeta (misma matrícula, matrícula parcial que encaja con una sola, o sin matrícula pero con un único
avión compatible cerca), y se eligen la principal y la segunda entre todas sus fotos.
