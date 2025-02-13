import express from "express";
import {
  getCurrentDayEarnings,
  getEarningsHistory,
} from "../controllers/driverEarningsController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

router.get("/current-day", verifyToken, getCurrentDayEarnings);
router.get("/history", verifyToken, getEarningsHistory);

export { router as driverEarningsRoutes };
