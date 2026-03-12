export const handler = async (event) => {
  const session = event.request.session;

  if (session.length === 0) {
    // First call — issue the custom challenge
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";

  } else if (session.length === 1 && session[0].challengeResult === true) {
    // Code was verified successfully → issue tokens
    event.response.issueTokens = true;
    event.response.failAuthentication = false;

  } else {
    // Wrong code or too many attempts
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  }

  return event;
};