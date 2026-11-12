# Bitácora Spotting (beta)

Web para que cada spotter lleve el registro de sus fotos. Los RAW se leen **en el navegador**:
no se suben los originales, solo una miniatura (~30 KB) de la foto elegida de cada ráfaga.

- `index.html`, `styles.css`, `js/app.js` — la app (HTML + JS sin compilación).
- `js/raw.js` — lectura de NEF/CR2/CR3/ARW/DNG/RAF: vista previa embebida, hora EXIF, ráfagas, nitidez y encuadre.
- `js/ia.js` + `api/identificar.js` — v0.2: identificación con IA (matrícula, tipo y operador). La web manda la
  foto elegida reducida y un recorte del avión; el servidor (función de Vercel) llama a la IA con la clave guardada en Vercel.
- `supabase/schema.sql` — tablas, permisos (cada usuario solo ve lo suyo) y almacén de miniaturas.
- `supabase/v0.2.sql` — lo nuevo de la v0.2 (columna `ia` y tabla `ai_uso` para el límite diario).
- `js/adsb.js` + `api/adsb.js` + `scripts/adsb_dia.py` + `.github/workflows/adsb.yml` — v0.3: cruce con ADS-B (adsb.lol).
- `supabase/v0.3.sql` — lo nuevo de la v0.3 (tabla `adsb_dias`, funciones para pedir días y almacén público `adsb`).
- `data/aeropuertos.json` — ICAO → coordenadas, elevación y zona horaria (de mwgg/Airports, licencia MIT).

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

**Unión por avión (v0.2.3):** al terminar la identificación se juntan en una sola entrada todas las ráfagas del mismo
avión de la carpeta (misma matrícula, matrícula parcial que encaja con una sola, o sin matrícula pero con un único
avión compatible cerca), y se eligen la principal y la segunda entre todas sus fotos.

**v0.2.4 (beta testers):**
- *Cortado*: el borde se compara con un degradado ajustado del cielo y con lo que hay en esa misma fila al otro lado
  del avión (horizonte, edificios, nubes), así que ya no marca como cortado un avión que llena la foto. Además la IA
  dice si el avión sale entero en la principal y en las tomas adicionales, y su respuesta manda.
- *Matrículas*: a la IA se le manda también el recorte de la segunda foto a resolución completa, y tras unir las
  ráfagas del mismo avión, si no se leyó la matrícula entera, se vuelve a leer una vez con la principal y la segunda
  nuevas.
- *Cortado (19/10)*: lo que calcula la web mirando los bordes ya solo es una sospecha («¿cortado?»), que resta un
  poco de nota pero nunca descarta una foto. Solo descarta «cortado» cuando lo confirma la IA; si la IA ve cortada la
  principal, se elige otra.
- *Hoja de contactos*: las tomas con sospecha de «¿cortado?» van en una sola imagen numerada y la IA dice en cuáles
  queda una parte del avión fuera del borde (acercarse o rozar el borde no cuenta).
- *Desactivado (19/10)*: «cortado» y «algo delante» ya no marcan ni descartan ninguna foto (daban más falsos avisos
  que aciertos). La principal se elige por nitidez y tamaño del avión. Se reactivan con `DETECTAR_CORTES = true` en
  js/raw.js.

## v0.3 · Cruce con ADS-B
Cada ráfaga se cruza con el historial ADS-B del aeropuerto (datos abiertos de [adsb.lol](https://adsb.lol), licencia ODbL)
para saber qué aviones estaban aterrizando, despegando, rodando o parados a la hora de la foto.

**Cómo funciona**
1. Al registrar una carpeta con el aeropuerto escrito, la web pide a `/api/adsb` los días de la carpeta. El servidor los pasa a
   días UTC con la zona horaria del aeropuerto y, si un día no está aún preparado, lanza el workflow «ADS-B día» de GitHub
   Actions. Este descarga el historial mundial de ese día (~3,7 GB), guarda solo los aviones que pasaron a menos de 15 km
   del aeropuerto por debajo de 6.000 ft sobre su elevación (~150–800 KB) y lo sube a Supabase. Tarda unos 4–5 min por día
   y solo se hace una vez: después vale para todos los usuarios.
2. En el navegador se calibra la hora de la cámara con las ráfagas cuya matrícula ya se conoce (leída por la IA o escrita a
   mano): el desfase bueno es el que pone a todos esos aviones en el aeropuerto, y cerca unos de otros, a la hora de su
   foto. Detecta solo cámaras con la hora de verano, minutos de adelanto o la hora de otro país. Se puede corregir a mano.
3. Para cada ráfaga dice: **✓ confirmada** (la matrícula estaba allí a esa hora), **⚠ posible error de lectura** (no
   estaba, pero sí otra casi igual del mismo tipo: botón «Usar …»), **matrícula propuesta** (la IA no la leyó, pero solo
   un avión de ese tipo o con esa matrícula parcial encaja; se escribe con borde discontinuo y la nota lo dice) o una
   **lista de candidatos** para elegir con un clic.
4. Las ráfagas que pasan a tener la misma matrícula se unen solas, como con la IA. Al guardar, el resultado va en la nota
   y en `ia.adsb`.

Historial disponible: desde el 10/03/2023 hasta ayer (adsb.lol publica cada día unas horas después de medianoche UTC).
En aeropuertos con poca cobertura en tierra (o aviones sin transpondedor) habrá ráfagas sin datos.

**Activarlo**
1. Supabase → SQL Editor → pegar `supabase/v0.3.sql` → Run.
2. Supabase → Project Settings → API Keys → crear una *secret key* (`sb_secret_…`). GitHub → este repositorio → Settings →
   Secrets and variables → Actions → New repository secret: `SUPABASE_SERVICE_KEY` = esa clave.
3. GitHub → tu perfil → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate:
   solo este repositorio, permiso *Actions: Read and write*. Vercel → Settings → Environment Variables:
   `GITHUB_TOKEN_ADSB` = ese token → Save → Redeploy.
Sin esas claves la web funciona igual que la v0.2 y la barra del ADS-B dice que aún no está activado.

Prueba manual del procesado: GitHub → Actions → «ADS-B día» → Run workflow (fecha `2026-11-10`, aeropuertos `LEVC`).
En local: `python3 scripts/adsb_dia.py 2026-11-10 LEVC --salida out/` (sin subir nada).

## v0.3.1 · Tipo ICAO fiable y tomas sueltas
- *Tipo coherente con el avión*: la IA escribe primero el fabricante y modelo que ve (`aeronave`) y después su designador.
  El servidor lo comprueba con la tabla ICAO (`data/tipos_icao.json` + `lib/tipos.js`): si el código es de otro avión
  (p. ej. SC7, el Short Skyvan, para un «Cessna 408 SkyCourier»), lo corrige (C408) o, si no está claro, lo marca para revisar.
- *Ficha de la matrícula*: primero se consulta [adsbdb](https://www.adsbdb.com) (base abierta, sin IA ni coste, al
  momento); si no conoce la matrícula, se siguen leyendo JetPhotos, airport-data y Planespotters con la IA. Si no hay
  ficha, la nota dice por qué (p. ej. «no está en adsbdb y las webs no dejaron leer la ficha (url_not_allowed)»).
- *ADS-B*: si la matrícula está confirmada a la hora de la foto, el tipo sale de la base de datos de adsb.lol.
- *Tomas sueltas*: con poca luz el detector del navegador a veces no ve el avión y la ráfaga se desmarcaba como «toma
  suelta», así que la IA ni la miraba. Ahora la IA también revisa esas tomas y, si ve un avión, la marca para guardar.
  Las que desmarcas tú no se tocan. La tarjeta dice siempre por qué está desmarcada.
- *RAW+JPG*: el NEF y el JPG de la misma foto (mismo nombre y hora) cuentan como una sola toma (se usa el RAW).

`data/tipos_icao.json` (designador → fabricante y modelo) sale de `webapp/src/db/types.json` de
[Mictronics/readsb-protobuf](https://github.com/Mictronics/readsb-protobuf) (GPL v3), que recoge el Doc 8643 de la OACI.

## v0.4 · Varios aeropuertos por carpeta (y aeropuerto automático)
- *Tramos*: la carpeta se parte al cambiar de día o tras más de 2 h sin fotos. Cada tramo tiene su aeropuerto, que va a la
  IA, al cruce con el ADS-B y a la entrada guardada. «Otro aeropuerto desde aquí» parte un tramo; «Unir con el tramo
  anterior» los junta. El campo de arriba pasa a ser el aeropuerto *por defecto* (vacío = automático).
- *Aeropuerto automático*: al procesar un día, el workflow saca también el **índice mundial de escalas**
  (`TODO/AAAA-MM-DD.json.gz`, ~1,7 MB): para cada matrícula, en qué aeropuertos estuvo y de qué hora a qué hora (aterrizajes,
  despegues y tiempo en tierra, aunque el aeropuerto no tenga cobertura en tierra). La web (`js/escalas.js`) busca el
  aeropuerto donde estaban las matrículas de cada tramo a la hora de sus fotos. Como la hora de la cámara no se sabe de
  antemano, prueba desfases de −12 h a +14 h: con una matrícula solo acepta la hora de casa o la local del aeropuerto
  (± 1 h, por la hora de verano sin cambiar); con dos o más que coinciden, cualquiera. Primero pide los días de la hora de
  casa ± 3 h; si algún tramo no aparece, todo el rango.
- Si escribes un aeropuerto por defecto y el ADS-B sitúa un tramo en otro, no lo cambia: lo avisa con un botón «Usar …».
- La hora de la cámara se calibra una vez para toda la carpeta, en UTC (sirve para un viaje con la cámara en hora de casa).
- Un avión que aterriza y despega sin cobertura en tierra cuenta como aparcado entre medias (antes salía «sin rastro»).
- Las ráfagas repetidas solo se unen dentro del mismo tramo: el mismo avión en otro aeropuerto es otra entrada.
- Límites: historial desde el 10/03/2023; hace falta al menos una matrícula leída por tramo; sin cobertura ADS-B no hay escalas.
- Nada que ejecutar en Supabase: el índice usa la misma tabla `adsb_dias` con el código especial `TODO`.
- *Ráfagas sin ajuste manual*: desaparece «Otro avión si pasan más de … s». El primer corte sigue siendo por tiempo
  (8 s sin fotos), porque el ADS-B necesita antes las matrículas de la IA para poner la cámara en hora. Con la cámara en
  hora (2 aviones identificados), el ADS-B sabe qué avión pasaba por delante en cada momento (`delanteEn`, el que se
  movía más cerca de la zona donde estaban los aviones identificados) y corrige el corte: junta ráfagas seguidas del
  mismo avión (< 3 min, mismo tramo, sin matrículas ni tipos que lo contradigan) y separa una ráfaga si dos trozos
  seguidos tenían delante aviones distintos y claros. No toca lo que unes o separas tú a mano. Sin ADS-B (antes de
  marzo de 2023 o sin cobertura) siguen valiendo el detector de imagen y las matrículas de la IA.
