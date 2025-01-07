import express from "express";
import { verifyToken } from "../middlewares/auth";
import {
  getHillStationFareEstimate,
  searchHillStationDrivers,
  acceptHillStationBooking,
  createAdvancePayment,
  verifyAdvancePayment,
  startDriverPickup,
  driverArrived,
  startRide,
  cancelBooking,
  getAvailableBookings,
  getBookingStatus,
  initiateRideCompletion,
  confirmRideCompletion,
  createFinalPaymentOrder,
  getAcceptedBookings,
} from "../controllers/hillStationController";

const router = express.Router();

// All routes except fare estimate are protected with auth middleware
router.post("/estimate", getHillStationFareEstimate);

// Protected routes
router.use(verifyToken);

// User routes
router.post("/search-drivers", searchHillStationDrivers);
router.post("/bookings/:bookingId/advance-payment", createAdvancePayment);
router.post(
  "/bookings/:bookingId/verify-advance-payment",
  verifyAdvancePayment
);
router.post(
  "/bookings/:bookingId/create-final-payment-order",
  createFinalPaymentOrder
);
router.post("/bookings/:bookingId/confirm-completion", confirmRideCompletion);

// Driver routes
router.post("/bookings/:bookingId/accept", acceptHillStationBooking);
router.post("/bookings/:bookingId/start-pickup", startDriverPickup);
router.post("/bookings/:bookingId/arrived", driverArrived);
router.post("/bookings/:bookingId/start", startRide);
router.get("/bookings/accepted", getAcceptedBookings);
router.get("/available-bookings", getAvailableBookings);
router.post("/bookings/:bookingId/initiate-completion", initiateRideCompletion);

// Common routes
router.post("/bookings/:bookingId/cancel", cancelBooking);
router.get("/bookings/:bookingId", getBookingStatus);

export { router as hillStationRouter };
