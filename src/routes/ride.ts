//ride.ts-> file

import express from "express";
import {
  createRide,
  getRide,
  updateRideStatus,
  getFareEstimation,
} from "../controllers/rideController";
import { verifyToken } from "../middlewares/auth";
import {
  getOutstationFareEstimate,
  createOutstationRide,
  getOutstationRequests,
} from "../controllers/outstationController";

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
router.post("/outstation", verifyToken, createOutstationRide);
router.get("/outstation/requests", verifyToken, getOutstationRequests);

export { router as rideRouter };
