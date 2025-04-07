import express from "express";
import {
  getCurrentDayEarnings,
  getEarningsHistory,
} from "../controllers/driverEarningsController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

// Fix type errors by wrapping handlers to avoid returning responses
router.get("/current-day", verifyToken, async (req, res, next) => {
  try {
    await getCurrentDayEarnings(req, res);
  } catch (error) {
    next(error);
  }
});

router.get("/history", verifyToken, async (req, res, next) => {
  try {
    await getEarningsHistory(req, res);
  } catch (error) {
    next(error);
  }
});

export { router as driverEarningsRoutes };
