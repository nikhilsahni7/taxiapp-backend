-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('USER', 'DRIVER', 'VENDOR', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "userType" "UserType" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT,
    "city" TEXT,
    "selfieUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDetails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverDetails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aadharNumber" TEXT,
    "panNumber" TEXT,
    "dlNumber" TEXT,
    "vehicleNumber" TEXT,
    "vehicleName" TEXT,
    "vehicleCategory" TEXT,
    "dlUrl" TEXT,
    "permitUrls" TEXT[],
    "carFrontUrl" TEXT,
    "carBackUrl" TEXT,

    CONSTRAINT "DriverDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDetails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT,
    "aadharNumber" TEXT,
    "panNumber" TEXT,
    "aadharFrontUrl" TEXT,
    "aadharBackUrl" TEXT,
    "panUrl" TEXT,

    CONSTRAINT "VendorDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OTP" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OTP_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserDetails_userId_key" ON "UserDetails"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverDetails_userId_key" ON "DriverDetails"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorDetails_userId_key" ON "VendorDetails"("userId");

-- AddForeignKey
ALTER TABLE "UserDetails" ADD CONSTRAINT "UserDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverDetails" ADD CONSTRAINT "DriverDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDetails" ADD CONSTRAINT "VendorDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
