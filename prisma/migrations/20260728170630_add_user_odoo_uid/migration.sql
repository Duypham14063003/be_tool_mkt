-- Odoo authentication stores the remote user id on the local user.
ALTER TABLE "User" ADD COLUMN "odooUid" INTEGER;

CREATE UNIQUE INDEX "User_odooUid_key" ON "User"("odooUid");
