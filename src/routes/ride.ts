//ride.ts-> file

import express from "express";
import {
  createRide,
  getRide,
  updateRideStatus,
  getFareEstimation,
  getChatMessages,
} from "../controllers/rideController";
import { verifyToken } from "../middlewares/auth";
import { getOutstationFareEstimate } from "../controllers/outstationController";

const router = express.Router();

router.post("/", verifyToken, createRide);
router.get("/:id", verifyToken, getRide);
router.put("/:id/status", verifyToken, updateRideStatus);
router.post("/fare-estimation", verifyToken, getFareEstimation);
router.post(
  "/outstation/fare-estimation",
  verifyToken,
  getOutstationFareEstimate
);
router.get("/:id/chat", verifyToken, getChatMessages);

export { router as rideRouter };
