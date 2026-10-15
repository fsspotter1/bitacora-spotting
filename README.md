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
   Opcionales: `AI_MODEL` (por defecto `claude-sonnet-5-5`), `AI_LIMITE_DIA` (por defecto 400 ráfagas por usuario y día),
   `GEMINI_API_KEY` + `AI_PROVIDER=gemini` para probar Gemini.
Sin clave, la web funciona igual que la v0.1 (registro a mano).

Navegadores: Chrome, Edge, Firefox o Safari recientes en ordenador.
