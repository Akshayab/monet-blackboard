import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import boardsRouter from "./boards";
import aiRouter from "./ai";
import sharingRouter from "./sharing";
import outputsRouter from "./outputs";
import templatesRouter from "./templates";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(boardsRouter);
router.use(aiRouter);
router.use(sharingRouter);
router.use(outputsRouter);
router.use(templatesRouter);

export default router;
