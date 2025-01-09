import express from "express";
import { verifyToken } from "../middlewares/auth";
import {
  getAllIndiaFareEstimate,
  createAllIndiaBooking,
  getAvailableAllIndiaBookings,
  acceptAllIndiaBooking,
  createAdvancePayment,
  verifyAdvancePayment,
  startDriverPickup,
  driverArrived,
  startRide,
  cancelBooking,
  getBookingStatus,
  initiateRideCompletion,
  confirmRideCompletion,
  createFinalPaymentOrder,
} from "../controllers/allIndiaController";

const router = express.Router();

// Public routes
router.post("/fare-estimate", getAllIndiaFareEstimate);

// Protected routes
router.use(verifyToken);

// User routes
router.post("/create-booking", createAllIndiaBooking);
router.post("/bookings/:bookingId/advance-payment", createAdvancePayment);
router.post(
  "/bookings/:bookingId/verify-advance-payment",
  verifyAdvancePayment
);

// Driver routes
router.get("/available-bookings", getAvailableAllIndiaBookings);
router.post("/bookings/:bookingId/accept", acceptAllIndiaBooking);
router.post("/bookings/:bookingId/start-pickup", startDriverPickup);
router.post("/bookings/:bookingId/arrived", driverArrived);
router.post("/bookings/:bookingId/start", startRide);

// Common routes
router.post("/bookings/:bookingId/cancel", cancelBooking);
router.get("/bookings/:bookingId", getBookingStatus);

// Ride completion routes
router.post("/bookings/:bookingId/initiate-completion", initiateRideCompletion);
router.post("/bookings/:bookingId/confirm-completion", confirmRideCompletion);
router.post(
  "/bookings/:bookingId/create-final-payment-order",
  createFinalPaymentOrder
);

export { router as allIndiaRoutes };
