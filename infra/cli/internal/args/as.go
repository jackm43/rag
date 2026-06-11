package args

import "jsmunro.me/platy/cli/internal/output"

func ParseAsFlag(cmdArgs []string) (application string, rest []string) {
	rest = cmdArgs
	for index := 0; index < len(rest); index++ {
		switch rest[index] {
		case "--as":
			if index+1 >= len(rest) {
				output.Fail("--as requires an application name")
			}
			application = rest[index+1]
			rest = append(append([]string{}, rest[:index]...), rest[index+2:]...)
			return application, rest
		}
	}
	return "", rest
}
