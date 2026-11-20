import { Router, type IRouter, type Request, type Response } from "express";
import { listTemplates } from "../templates";

const router: IRouter = Router();

// Board templates offered in the library ("Start new"). Create one with POST /api/boards { template }.
router.get("/templates", (_req: Request, res: Response) => {
  res.json({ templates: listTemplates() });
});

export default router;
