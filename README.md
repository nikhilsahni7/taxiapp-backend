# Taxisure - Cab Booking Service Backend

## Overview

This is a full-stack cab booking service platform backend built with modern Node.js technologies. The backend serves a mobile application developed in Flutter (private repository) that enables various transportation services including local rides, outstation trips, hill station visits, and special services like Chardham Yatra.

## Tech Stack

- **Runtime Environment**: [Bun](https://bun.sh/) - A fast all-in-one JavaScript runtime
- **Backend Framework**: Node.js with Express
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Real-time Communication**: socket.io
- **Payment Processing**: Razorpay integration

## Features

- **Multi-user System**:

  - User accounts (passengers)
  - Driver accounts with vehicle details
  - Vendor accounts for business partners
  - Admin dashboard for management

- **Booking Services**:

  - Local rides within city
  - Outstation trips (one-way and round trips)
  - Hill station packages
  - Chardham Yatra pilgrimage packages
  - All India tour packages
  - Car rental services

- **Real-time Features**:

  - Live driver tracking
  - Real-time ride status updates
  - In-app chat between driver and passenger

- **Payment System**:

  - Multiple payment options (Cash, Online)
  - Wallet integration for users
  - Vendor payouts
  - Driver commission management
  - Transparent fare calculation

- **Secure Authentication**:
  - Phone number verification with OTP
  - Driver and vendor verification process

## Project Structure

The project follows a modular architecture with the following key components:

- **Controllers**: Handle HTTP requests and business logic
- **Models**: Prisma schema defining the database structure
- **Routes**: Define API endpoints
- **Services**: Contain business logic separated from controllers
- **Utils**: Helper functions and utilities
- **Middlewares**: Request processing middleware
- **Socket**: Real-time communication handling

## Database Schema

The database design includes models for:

- Users (with different roles - passenger, driver, vendor, admin)
- Rides and Bookings (different types based on service)
- Transactions and Payments
- Vehicle and Driver Details
- Vendor Management
- Chat Messages
- Location Tracking

## Setup and Installation

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run server.ts
```

## Environment Variables

Create a `.env` file with the following variables:

```
DATABASE_URL="postgresql://username:password@localhost:5432/dbname"
PORT=3000
JWT_SECRET=your_jwt_secret
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_SECRET=your_razorpay_secret
ADMIN_USER_ID=uuid_of_admin_user
GOOGLE_MAPS_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

```

## Frontend Application

The frontend is developed in Flutter and is maintained in a private repository. The mobile application consumes the APIs provided by this backend service and offers a seamless user experience for both passengers and drivers.

Features of the mobile app include:

- User and driver interfaces
- Real-time ride tracking
- In-app navigation
- Secure payments
- Booking management
- Profile management
- Rating and review system
- Push notifications

## Production Deployment

For production deployment:

1. Build the TypeScript code with `bun run build`
2. Set up a production-ready PostgreSQL database
3. Configure proper environment variables for production
4. Use a process manager like PM2 or containerize with Docker
5. Set up NGINX or similar as a reverse proxy
6. Configure proper SSL certificates

This project was created using `bun init`. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## License

This project is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.
