// Tarea programada de Netlify: cada 15 min pasa de equipo lo vencido y envía los recordatorios de confirmación.
import { cronJob } from "./api.mjs";
export default async () => { await cronJob(); return new Response("ok"); };
export const config = { schedule: "*/15 * * * *" };
