# Bingo Online 2026 - Rotary Club Rukapillán

App estática de código fuente público para sorteos de bingo online.

La versión actual conserva el tablero visual original, confetti, historial, últimos 3 resultados, segmentos B-I-N-G-O y números 1-75 sin repetición. La diferencia importante es que el estado vivo del sorteo ahora es autoritativo en Supabase: el navegador solo renderiza y solicita acciones mediante RPC.

## MVP implementado

- Crear lobby con nombre y contraseña del anfitrión.
- Unirse a lobby con código corto.
- Host puede usar **Sacar número**; viewers quedan en **Solo lectura**.
- Supabase Realtime actualiza viewers sin refrescar.
- Token de host se guarda en `sessionStorage`, no en `localStorage`.
- Si se pierde el token, **Tomar control** permite reclamar el rol con la contraseña del anfitrión.
- **Nuevo sorteo** cierra el draw actual, guarda cierre inmutable y crea un nuevo draw activo.
- Los draws cerrados no se modifican ni se borran.
- Producción no depende de `server.mjs`.

Fuera de alcance por ahora: QR, cuentas de usuario, roles complejos, animaciones nuevas y backend propio.

## Archivos importantes

- `index.html` — UI estática y carga de Supabase JS CDN.
- `styles.css` — estilos existentes + panel de lobby.
- `app.js` — flujo lobby/host/viewer, RPC y Realtime.
- `supabaseConfig.js` — URL + anon key pública de Supabase.
- `supabase/migrations/20260611_live_bingo_mvp.sql` — schema, RLS, RPC y publicación Realtime.
- `server.mjs` — servidor local opcional heredado; no se usa en GitHub Pages.

## Configuración de Supabase

1. Crea un proyecto en Supabase.
2. Abre SQL Editor y ejecuta todo el contenido de:

```text
supabase/migrations/20260611_live_bingo_mvp.sql
```

3. Verifica que Realtime tenga publicadas estas tablas:

- `public.draw_events`
- `public.draws`
- `public.lobbies`

La migración intenta agregarlas a `supabase_realtime`; si tu proyecto requiere hacerlo desde dashboard, usa **Database → Publications → supabase_realtime**.

4. Copia desde Supabase:

- Project URL
- `anon` public key

5. Edita `supabaseConfig.js`:

```js
window.BINGO_SUPABASE_CONFIG = {
  url: "https://TU_PROJECT_REF.supabase.co",
  anonKey: "TU_ANON_KEY_PUBLICA"
};
```

No pongas `service_role`, contraseña de base de datos, JWT secret ni claves privadas en el frontend.

## Seguridad del modelo

- La contraseña del anfitrión no se hardcodea en JS.
- Supabase guarda hash de contraseña con `crypt()`.
- El host token se genera aleatoriamente, se guarda hasheado en DB y se entrega al host una sola vez.
- El navegador guarda el host token en `sessionStorage`.
- Viewers no tienen permisos directos de escritura.
- Las escrituras de estado pasan por funciones RPC `SECURITY DEFINER`:
  - `create_lobby`
  - `claim_host`
  - `renew_host_lock`
  - `draw_next_number`
  - `close_draw_and_create_new`
- `draw_next_number` usa lock transaccional + constraints únicas para evitar duplicados por concurrencia.

## Uso local

Puedes abrir `index.html` directamente, pero para evitar restricciones del navegador es mejor servir la carpeta:

```bash
python3 -m http.server 8087
```

Luego entra a:

```text
http://localhost:8087
```

También puedes usar el servidor heredado:

```powershell
node .\server.mjs
```

## Deploy en GitHub Pages

1. Sube estos archivos al repositorio.
2. En GitHub: **Settings → Pages**.
3. Source: branch principal, carpeta raíz.
4. Espera la URL de Pages.
5. Abre la app desde esa URL.

No hay build step.

## Prueba de aceptación manual

1. Abre la app en navegador A.
2. **Crear lobby** con nombre y contraseña.
3. Copia el **Código de lobby**.
4. Abre navegador B/incógnito/dispositivo distinto.
5. **Unirse a lobby** con el código.
6. En A, pulsa **Sacar número**.
7. B debe actualizar automáticamente sin refrescar.
8. En Supabase, confirma una fila nueva en `draw_events`.
9. Refresca B: debe recargar historial completo.
10. Refresca A: debe seguir como host si el token continúa en `sessionStorage`.
11. Borra `sessionStorage` en A y usa **Tomar control** con la contraseña.
12. Prueba dos hosts pulsando a la vez: no debe haber duplicados por draw.
13. Pulsa **Nuevo sorteo**: el draw anterior queda `closed`, aparece un draw activo nuevo y viewers ven el reset.
14. Intenta llamar `draw_next_number` sobre un draw cerrado: debe fallar.
15. Al llegar a 75 números, el botón indica **Todos los números ya fueron sorteados**.

## Reglas originales preservadas

- Segmentos: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75.
- Historial completo visible.
- Últimos 3 resultados visibles.
- Números no repetidos dentro de un draw.
- Confetti al salir un número.
- UX en español.

## Licencia

Este proyecto está bajo la licencia AGPL-3.0.

Se requiere la atribución. Por favor, mantenga el aviso de derechos de autor, el archivo de licencia y el archivo NOTICE en las copias, bifurcaciones, implementaciones públicas y versiones modificadas.

Se agradecen las donaciones, pero no son obligatorias a menos que un acuerdo escrito independiente indique lo contrario.
