import express from "express";
import { verifyToken } from "../middlewares/auth";
import {
  getChardhamFareEstimate,
  createChardhamBooking,
  verifyAdvancePayment,
  getAvailableChardhamBookings,
  acceptChardhamBooking,
  startDriverPickup,
  driverArrived,
  startRide,
  getBookingStatus,
  getAcceptedBookings,
  cancelBooking,
} from "../controllers/chardhamController";

const router = express.Router();

// Public routes
router.post("/fare-estimate", getChardhamFareEstimate);

// Protected routes
router.use(verifyToken);

// User routes
router.post("/create-booking", createChardhamBooking);
router.post(
  "/bookings/:bookingId/verify-advance-payment",
  verifyAdvancePayment
);

// Driver routes
router.get("/available-bookings", getAvailableChardhamBookings);
router.get("/bookings/accepted", getAcceptedBookings);
router.post("/bookings/:bookingId/accept", acceptChardhamBooking);
router.post("/bookings/:bookingId/start-pickup", startDriverPickup);
router.post("/bookings/:bookingId/arrived", driverArrived);
router.post("/bookings/:bookingId/start", startRide);

// Common routes
router.get("/bookings/:bookingId", getBookingStatus);
router.post("/bookings/:bookingId/cancel", cancelBooking);

export { router as chardhamRoutes };
