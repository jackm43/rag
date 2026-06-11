package args

func HasHelpFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}

func StripHelpFlag(args []string) []string {
	kept := []string{}
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			continue
		}
		kept = append(kept, arg)
	}
	return kept
}
