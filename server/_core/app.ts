import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { scheduledDailyReport } from "../scheduledReports";

/** Shared Express app: used by the local server and the Vercel serverless handler. */
export function createApp() {
  const app = express();
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Vercel Cron issues GET; manual triggers use POST.
  app.get("/api/scheduled/dailyReport", scheduledDailyReport);
  app.post("/api/scheduled/dailyReport", scheduledDailyReport);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  return app;
}
