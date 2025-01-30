import express from "express";
import { CarRentalController } from "../controllers/carRentalController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const carRentalController = new CarRentalController();

// Create new booking
router.post("/bookings", verifyToken, carRentalController.createBooking);

// Get booking details
router.get("/bookings/:id", verifyToken, carRentalController.getBooking);

// Cancel booking
router.post(
  "/bookings/:id/cancel",
  verifyToken,
  carRentalController.cancelBooking
);

// Accept booking
router.post(
  "/bookings/:id/accept",
  verifyToken,
  carRentalController.acceptBooking
);

// Reject booking
router.post(
  "/bookings/:id/reject",
  verifyToken,
  carRentalController.rejectBooking
);

// Get available bookings for driver
router.get(
  "/driver/available-bookings",
  verifyToken,
  carRentalController.getAvailableBookings
);

export const carRentalRouter = router;
