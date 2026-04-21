package main

import "testing"

func TestSanity(t *testing.T) {
	if 1+1 != 2 {
		t.Fatalf("math broken")
	}
}
