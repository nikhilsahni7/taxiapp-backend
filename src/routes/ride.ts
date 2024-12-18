import express from "express";
import {
  createRide,
  getRide,
  updateRideStatus,
} from "../controllers/rideController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

router.post("/", verifyToken, createRide);
router.get("/:id", verifyToken, getRide);
router.put("/:id/status", verifyToken, updateRideStatus);

export { router as rideRouter };
