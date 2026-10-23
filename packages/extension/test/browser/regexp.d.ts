// The browser tests check what a page shows with RegExp#test, and an element with no text gives them null, which
// test() reads as the string "null": no match, which is what those checks mean. So test() takes null here.
interface RegExp {
  test(string: string | null | undefined): boolean;
}
