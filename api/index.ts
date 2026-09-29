import type { Request, Response } from "express";
import { createApp } from "../server/_core/app";

const app = createApp();

/** Vercel serverless entry point. vercel.json rewrites /api/(.*) here. */
export default function handler(req: Request, res: Response) {
  app(req, res);
}
