#!/usr/bin/env python3
"""v0.3 · ADS-B. Descarga un día del historial global de adsb.lol y guarda, para cada aeropuerto pedido, las trazas
de los aviones que pasaron cerca (a menos de RADIO_KM y por debajo de la elevación + TECHO_FT). Lo ejecuta GitHub
Actions (.github/workflows/adsb.yml); la web descarga el resultado (un JSON comprimido de unos cientos de KB) y hace
el cruce con las fotos en el navegador.

Fuente: adsb.lol (licencia ODbL: hay que citar «adsb.lol»). Cada día UTC se publica en
github.com/adsblol/globe_history_<AÑO>, release v<AAAA.MM.DD>-planes-readsb-prod-0, partes .tar.aa, .tar.ab… (~3,7 GB).

Uso:
  python3 scripts/adsb_dia.py 2026-11-10 LEVC,LEMD --salida out/          # solo genera los archivos
  python3 scripts/adsb_dia.py 2026-11-10 LEVC --subir                      # y los sube a Supabase
Con --subir procesa además todos los aeropuertos que estén «pendiente» ese día en la tabla adsb_dias.
Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY (clave service_role, solo como secreto de GitHub).
"""
import argparse, gzip, http.client, io, json, math, os, re, socket, sys, tarfile, time, urllib.error, urllib.parse, urllib.request
from datetime import date, datetime, timezone

try:
    import orjson
    cargar = orjson.loads
except ImportError:   # funciona igual, solo más lento
    cargar = json.loads

RADIO_KM = 15        # alrededor del punto de referencia del aeropuerto
TECHO_FT = 6000      # sobre la elevación del aeropuerto
MIN_DT = 4           # segundos mínimos entre puntos guardados (salvo cambio de suelo/aire)
AQUI = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(datetime.now().strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


class Partes(io.RawIOBase):
    """Las partes .tar.aa, .tar.ab… de la release como un único flujo, con reintentos que retoman donde se cortó."""

    def __init__(self, base):
        self.base, self.sufijos, self.resp, self.parte, self.pos, self.total, self.leido = base, self._sufijos(), None, None, 0, None, 0

    @staticmethod
    def _sufijos():
        for a in 'abcdefghij':
            for b in 'abcdefghijklmnopqrstuvwxyz':
                yield a + b

    def readable(self):
        return True

    def _abrir(self):
        h = {'User-Agent': 'bitacora-spotting/0.3 (+https://github.com/Fsspotter1/bitacora-spotting)'}
        if self.pos:
            h['Range'] = f'bytes={self.pos}-'
        self.resp = urllib.request.urlopen(urllib.request.Request(self.base + self.parte, headers=h), timeout=120)
        if self.total is None:
            cr = self.resp.headers.get('Content-Range')
            self.total = int(cr.split('/')[-1]) if cr else int(self.resp.headers.get('Content-Length') or 0)

    def readinto(self, buf):
        fallos = 0
        while True:
            try:
                if self.resp is None:
                    if self.parte is None:
                        self.parte, self.pos, self.total = next(self.sufijos), 0, None
                    try:
                        self._abrir()
                    except urllib.error.HTTPError as e:
                        if e.code == 404 and self.pos == 0:
                            if self.parte == 'aa':
                                raise SinDatos()
                            return 0   # no hay más partes: fin del tar
                        raise
                n = self.resp.readinto(buf)
                if n:
                    self.pos += n
                    self.leido += n
                    return n
                if self.total and self.pos < self.total:
                    raise ConnectionError('corte antes de tiempo')
                self.resp, self.parte = None, None   # parte terminada: a por la siguiente
            except SinDatos:
                raise
            except (urllib.error.URLError, http.client.HTTPException, ConnectionError, socket.timeout, TimeoutError, OSError) as e:
                fallos += 1
                if fallos > 8:
                    raise
                log(f'red: {e!r}; reintento {fallos} desde {self.pos} de .{self.parte}')
                self.resp = None
                time.sleep(min(60, 3 * fallos))


class SinDatos(Exception):
    pass


def aeropuertos(codigos):
    db = json.load(open(os.path.join(AQUI, '..', 'data', 'aeropuertos.json')))
    out, malos = {}, []
    for c in codigos:
        v = db.get(c)
        if v:
            lat, lon, elev, tz = v
            out[c] = {'lat': lat, 'lon': lon, 'elev': elev, 'tz': tz, 'cos': math.cos(math.radians(lat)),
                      'dlat': RADIO_KM / 111.2, 'dlon': RADIO_KM / (111.2 * math.cos(math.radians(lat))), 'techo': elev + TECHO_FT,
                      'aviones': []}
        else:
            malos.append(c)
    return out, malos


def procesar(fecha, apts):
    y, m, d = fecha.split('-')
    tag = f'v{y}.{m}.{d}-planes-readsb-prod-0'
    base = f'https://github.com/adsblol/globe_history_{y}/releases/download/{tag}/{tag}.tar.'
    t_dia = datetime(int(y), int(m), int(d), tzinfo=timezone.utc).timestamp()
    lista = list(apts.values())
    flujo = Partes(base)
    n = 0
    t0 = time.time()
    with tarfile.open(fileobj=io.BufferedReader(flujo, 1 << 20), mode='r|') as tf:
        for mem in tf:
            if not mem.isfile() or 'trace_full' not in mem.name:
                continue
            n += 1
            raw = tf.extractfile(mem).read()
            try:
                tr = cargar(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
            except Exception:
                continue
            b0 = tr.get('timestamp', 0) - t_dia
            pts = tr.get('trace') or []
            if not pts:
                continue
            for a in lista:
                la0, lo0, dla, dlo = a['lat'], a['lon'], a['dlat'], a['dlon']
                keep, cs, ultimo_cs, prev_t, prev_g = [], [], None, -1e9, None
                for p in pts:
                    det = p[8] if len(p) > 8 else None
                    if det and det.get('flight'):
                        ultimo_cs = det['flight'].strip()
                    la, lo = p[1], p[2]
                    if la is None or lo is None or abs(la - la0) > dla or abs(lo - lo0) > dlo:
                        continue
                    alt = p[3]
                    g = alt == 'ground'
                    if not g and alt is not None and alt > a['techo']:
                        continue
                    if math.hypot((la - la0) * 111.2, (lo - lo0) * 111.2 * a['cos']) > RADIO_KM:
                        continue
                    t = int(round(b0 + p[0]))
                    if t - prev_t < MIN_DT and g == prev_g:
                        continue
                    prev_t, prev_g = t, g
                    altc = -1 if g else (-2 if alt is None else int(alt))
                    gs = p[4]
                    keep.append([t, int(round(la * 1e5)), int(round(lo * 1e5)), altc, -1 if gs is None else int(round(gs))])
                    if ultimo_cs and (not cs or cs[-1][1] != ultimo_cs):
                        cs.append([t, ultimo_cs])
                if keep:
                    av = {'h': tr.get('icao', ''), 'r': tr.get('r') or '', 't': tr.get('t') or '', 'd': tr.get('desc') or '', 'p': keep}
                    if cs:
                        av['cs'] = cs
                    if (tr.get('dbFlags') or 0) & 1:
                        av['mil'] = 1
                    a['aviones'].append(av)
            if n % 20000 == 0:
                log(f'{n} trazas · {flujo.leido / 1e9:.2f} GB · {int(time.time() - t0)} s · ' + ' '.join(f'{c}:{len(v["aviones"])}' for c, v in apts.items()))
    log(f'fin: {n} trazas, {flujo.leido / 1e9:.2f} GB en {int(time.time() - t0)} s')
    salida = {}
    for c, a in apts.items():
        # el mismo avión puede venir en dos trazas (cambio de hex no, pero sí de archivo): se juntan por hex
        por_hex = {}
        for av in a['aviones']:
            x = por_hex.get(av['h'])
            if x:
                x['p'] = sorted(x['p'] + av['p'])
                x.setdefault('cs', []).extend(av.get('cs', []))
            else:
                por_hex[av['h']] = av
        doc = {'v': 1, 'aeropuerto': c, 'fecha': fecha, 'lat': a['lat'], 'lon': a['lon'], 'elev': a['elev'], 'tz': a['tz'],
               'radio_km': RADIO_KM, 'techo_ft': TECHO_FT, 'fuente': 'adsb.lol (ODbL)',
               'formato': 'p = [segundos desde 00:00 UTC, lat·1e5, lon·1e5, altitud ft (-1 suelo, -2 desconocida), velocidad kt (-1 desconocida)]',
               'generado': datetime.now(timezone.utc).isoformat(timespec='seconds'),
               'aviones': sorted(por_hex.values(), key=lambda v: v['p'][0][0])}
        salida[c] = gzip.compress(json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode(), 9)
    return salida


# ---------- Supabase (solo con --subir) ----------
def sb(metodo, ruta, cuerpo=None, cabeceras=None):
    url = os.environ['SUPABASE_URL'].rstrip('/') + ruta
    k = os.environ['SUPABASE_SERVICE_KEY']
    h = {'apikey': k, 'Authorization': f'Bearer {k}', **(cabeceras or {})}
    if isinstance(cuerpo, (dict, list)):
        cuerpo = json.dumps(cuerpo).encode()
        h.setdefault('Content-Type', 'application/json')
    for intento in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=cuerpo, method=metodo, headers=h), timeout=120) as r:
                txt = r.read()
                return json.loads(txt) if txt and r.headers.get_content_type() == 'application/json' else None
        except urllib.error.HTTPError as e:
            msg = e.read()[:300]
            if e.code < 500 or intento == 4:
                raise RuntimeError(f'Supabase {metodo} {ruta}: {e.code} {msg!r}')
        except (urllib.error.URLError, OSError):
            if intento == 4:
                raise
        time.sleep(2 + 3 * intento)


def estado(fecha, codigos, **campos):
    if not codigos:
        return
    campos['actualizado'] = datetime.now(timezone.utc).isoformat()
    q = urllib.parse.urlencode({'fecha': f'eq.{fecha}', 'aeropuerto': f'in.({",".join(codigos)})'})
    sb('PATCH', f'/rest/v1/adsb_dias?{q}', campos, {'Prefer': 'return=minimal'})


def pendientes(fecha):
    q = urllib.parse.urlencode({'fecha': f'eq.{fecha}', 'estado': 'eq.pendiente', 'select': 'aeropuerto'})
    return [r['aeropuerto'] for r in sb('GET', f'/rest/v1/adsb_dias?{q}') or []]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('fecha')
    ap.add_argument('aeropuertos', help='ICAO separados por comas')
    ap.add_argument('--salida', default='')
    ap.add_argument('--subir', action='store_true')
    a = ap.parse_args()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', a.fecha):
        sys.exit('fecha no válida')
    date.fromisoformat(a.fecha)
    pedidos = [c for c in re.split(r'[,\s]+', a.aeropuertos.upper()) if c]
    if any(not re.fullmatch(r'[A-Z0-9]{4}', c) for c in pedidos):
        sys.exit('aeropuerto no válido')
    if a.subir:
        pedidos = sorted(set(pedidos) | set(pendientes(a.fecha)))
    apts, malos = aeropuertos(pedidos)
    if a.subir:
        estado(a.fecha, malos, estado='error', mensaje='Aeropuerto desconocido: revisa el código ICAO.')
        estado(a.fecha, list(apts), estado='procesando', mensaje='')
    if not apts:
        log('nada que hacer'); return
    log(f'{a.fecha}: {", ".join(apts)}')
    try:
        archivos = procesar(a.fecha, apts)
    except SinDatos:
        reciente = (date.today() - date.fromisoformat(a.fecha)).days < 4
        msg = 'adsb.lol aún no ha publicado ese día (suele tardar unas horas tras medianoche UTC).' if reciente else 'No hay historial ADS-B de ese día en adsb.lol.'
        log(msg)
        if a.subir:
            estado(a.fecha, list(apts), estado='sin_datos', mensaje=msg)
        return
    except Exception as e:
        if a.subir:
            estado(a.fecha, list(apts), estado='error', mensaje=f'Fallo al procesar: {str(e)[:200]}')
        raise
    for c, gz in archivos.items():
        n = len(json.loads(gzip.decompress(gz))['aviones'])
        log(f'{c}: {n} aviones, {len(gz) / 1024:.0f} KB')
        if a.salida:
            os.makedirs(a.salida, exist_ok=True)
            open(os.path.join(a.salida, f'{c}_{a.fecha}.json.gz'), 'wb').write(gz)
        if a.subir:
            ruta = f'{c}/{a.fecha}.json.gz'
            sb('POST', f'/storage/v1/object/adsb/{ruta}', gz, {'Content-Type': 'application/gzip', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000'})
            estado(a.fecha, [c], estado='listo', aviones=n, bytes=len(gz), ruta=ruta, mensaje='')


if __name__ == '__main__':
    main()
