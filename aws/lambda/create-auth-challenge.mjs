export const handler = async (event) => {
  // No challenge metadata needed — the code is already in the URL
  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = {};

  event.response.publicChallengeParameters.foo = "foo";
  event.response.privateChallengeParameters.bar = "bar";
  event.response.challengeMetadata = "MAGIC_LINK";

  console.log(event);
  return event;
};