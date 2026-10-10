# Bitácora Spotting (beta)

Web para que cada spotter lleve el registro de sus fotos. Los RAW se leen **en el navegador**:
no se suben los originales, solo una miniatura (~30 KB) de la foto elegida de cada ráfaga.

- `index.html`, `styles.css`, `js/app.js` — la app (HTML + JS sin compilación).
- `js/raw.js` — lectura de NEF/CR2/CR3/ARW/DNG/RAF: vista previa embebida, hora EXIF, ráfagas, nitidez y encuadre.
- `supabase/schema.sql` — tablas, permisos (cada usuario solo ve lo suyo) y almacén de miniaturas.

## Puesta en marcha
1. Supabase → SQL Editor → pegar `supabase/schema.sql` → Run.
2. Supabase → Authentication → Sign In / Providers → Email → desactivar «Confirm email» (beta).
3. Vercel → Add New → Project → importar este repositorio → Deploy (sin configuración: es estático).
4. Supabase → Authentication → URL Configuration → Site URL = la dirección de Vercel.

Navegadores: Chrome, Edge, Firefox o Safari recientes en ordenador.
