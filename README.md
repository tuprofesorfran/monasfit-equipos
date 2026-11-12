# MonasFIT Salud (IES Monastil · Aula Ateca)

Rotación de los 12 equipos de alumnado en los entrenamientos del profesorado, equipo fijo en las valoraciones, agenda por equipo y prescripción enlazada a cada profesor.

Es un proyecto nuevo e independiente. No toca `monasfit.netlify.app` ni `monasfit-api`.

## Qué hay en la carpeta

- `public/index.html`: la aplicación (lo que ve el alumnado y el coordinador).
- `netlify/functions/api.mjs`: el servidor (guarda reservas, equipos y prescripciones en Netlify Blobs).
- `package.json` y `netlify.toml`: configuración. Netlify instala solo lo que necesita.

## Publicarla (GitHub + Netlify, como monasfit-api)

Arrastrar la carpeta directamente a Netlify no sirve aquí, porque el servidor necesita que Netlify instale un paquete.

1. En GitHub crea un repositorio nuevo llamado `monasfit-equipos`.
2. Pulsa **Add file → Upload files** y arrastra el contenido de esta carpeta (`public`, `netlify`, `package.json`, `netlify.toml`, `.gitignore`). Comprueba que se conservan las carpetas. Confirma con **Commit changes**.
3. En Netlify: **Add new project → Import an existing project → GitHub** y elige `monasfit-equipos`. No pongas comando de build. Netlify lee `netlify.toml`.
4. Antes de publicar, o justo después, ve a **Project configuration → Environment variables** y crea:
   - `ADMIN_PASSWORD`: la contraseña de coordinación. Obligatoria. Márcala como secreta.
   - `ACCESS_CODE`: un código que el alumnado escribe al abrir la app. Opcional. Si no la creas, entra cualquiera con el enlace.
5. Si has creado las variables después del primer deploy, pulsa **Deploys → Trigger deploy → Deploy site**.

## Reservar (profesorado)

- El profesorado entra en `https://monasfit-salud.netlify.app/#reservar`, escribe su nombre, elige E o V y una franja libre. Al confirmar ve al momento qué equipo le toca.
- Puede cancelar sus reservas desde el mismo móvil. Otra persona no puede cancelarlas.
- La pantalla es un calendario semanal. Cada día solo se abren las franjas en las que el alumnado está en el aula Ateca (configuradas de serie igual que la app anterior).
- Las plazas por franja, los días y franjas abiertas, el profesor responsable y los días cerrados se configuran en **Gestión → Disponibilidad para reservar**.

## Primer uso

1. Abre la web y pulsa **Acceso coordinación** (al pie de la página). Entra con tu contraseña.
2. En **Gestión → Equipos**, escribe las parejas y guarda.
3. En **Pegar varias reservas**, copia las reservas con este formato, una por línea: `fecha, franja, profesor, tipo`. Ejemplo: `12/11, 3, Laura J., E`. La franja es 1 a 6 (la 1 es 7:55–8:50).
4. Los equipos se reparten solos. El alumnado abre el enlace, elige su número de equipo y ve su agenda.

## Reglas de la rotación

- Cada entrenamiento nuevo pasa al siguiente equipo, empezando por el 1, por orden de fecha y hora.
- Las valoraciones van siempre al equipo que ya valoró a ese profesor. La primera vez se reparte con la misma rotación.
- Si un equipo ya tiene otra sesión en esa franja, se salta al siguiente.
- "Víctor M." y "Victor M." cuentan como el mismo profesor.

## Privacidad

- Solo el equipo que valora a un profesor puede escribir su prescripción, y solo ese equipo y el que lo entrena la ven. Lo comprueba el servidor, aunque el alumnado no tiene contraseña personal.
- Las reservas y las agendas las ve cualquiera que entre en la app.
