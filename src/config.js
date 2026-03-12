window.AppConfig = {
    REGION: 'eu-central-1',
    USER_POOL_ID: 'eu-central-1_xxxxxxx',
    CLIENT_ID: 'xxxx',
    IDENTITY_POOL_ID: 'eu-central-1:xxxx',
    HOST_URL: 'https://example.com',
    ROLES: {
        ADMIN: 'admin',
        GUEST: 'guest'
    },
    LAMBDAS: {
        BOOKING_REQUEST: 'llama-portal-demo-booking-request',
        MANAGE_BOOKINGS: 'llama-portal-demo-manage-bookings',
        GENERATE_INVITATION_CODE: 'llama-portal-demo-generate-invitation-code',
        MANAGE_ROOMS: 'llama-portal-demo-manage-rooms',
        MOVE_ALLOCATIONS: 'llama-portal-demo-move-allocations'
    },
    DB: {
        TABLE_NAME: 'llama-portal-demo-BookingTable',
    }
};
