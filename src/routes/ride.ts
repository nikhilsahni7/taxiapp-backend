//ride.ts-> file

import express from "express";
import {
  createRide,
  getRide,
  updateRideStatus,
  getFareEstimation,
} from "../controllers/rideController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

router.post("/", verifyToken, createRide);
router.get("/:id", verifyToken, getRide);
router.put("/:id/status", verifyToken, updateRideStatus);
router.post("/fare-estimation", verifyToken, getFareEstimation);

export { router as rideRouter };
