import random
import statistics

# Parameters (tweak these)
INITIAL_H = 200
INITIAL_M = 10
TICKS = 1000

r_H = 0.02             # reproduction prob per H per tick
p_transmit = 0.7       # knowledge inheritance chance
N_thresh = 5           # kills required for M -> H conversion
alpha_kill_base = 0.3  # base kill chance for M
train_rate = 0.01      # per tick chance to gain evolution progress
death_penalty_loss = 0.5   # fraction of skill retained after M killed (0..1)
aggression_gain_on_death = 0.2
phi = 0.5              # H_points decay fraction on M death
H_defense_base = 0.1   # base chance H kills M on encounter

# Agent classes
class H:
    def __init__(self, knowledge=0.1):
        self.knowledge = knowledge
        self.alive = True

class M:
    def __init__(self, skill=0.1, evolution=0, h_points=0, aggression=0.0):
        self.skill = skill
        self.evolution = evolution
        self.h_points = h_points
        self.aggression = aggression
        self.alive = True

# initialize populations
H_pop = [H(knowledge=0.2) for _ in range(INITIAL_H)]
M_pop = [M(skill=0.2) for _ in range(INITIAL_M)]

def p_m_kill(m: M, h: H):
    evo_bonus = 0.1 * m.evolution
    return min(0.95, alpha_kill_base + m.skill + m.aggression + evo_bonus)

def p_h_kill(h: H, m: M):
    # H defense improves with knowledge and base
    return min(0.95, H_defense_base + 0.5 * h.knowledge)

for tick in range(TICKS):
    # shuffle to randomize encounters
    random.shuffle(M_pop)
    random.shuffle(H_pop)

    # encounters: assume each M meets a random H with some probability
    if len(H_pop) == 0:
        print("All H extinct at tick", tick)
        break

    # M actions
    for m in list(M_pop):
        if not H_pop: break
        # chance to encounter an H is proportional to densities
        encounter_prob = min(1.0, len(H_pop) / (len(H_pop) + 5))  # tweak
        if random.random() > encounter_prob:
            # maybe train instead
            if random.random() < train_rate:
                m.evolution = min(2, m.evolution + 1)  # quick progression
                m.skill += 0.05
            continue

        h = random.choice(H_pop)
        if random.random() < p_m_kill(m, h):
            # M kills H
            try:
                H_pop.remove(h)
            except ValueError:
                pass
            m.h_points += 1
            m.skill += 0.02
            # check conversion
            if m.h_points >= N_thresh:
                # convert to H
                newH = H(knowledge = min(1.0, m.skill))
                H_pop.append(newH)
                try:
                    M_pop.remove(m)
                except ValueError:
                    pass
                continue
        else:
            # H defends and may kill M
            if random.random() < p_h_kill(h, m):
                # M is killed and respawns (we simulate respawn by resetting stats)
                m.skill *= death_penalty_loss
                m.evolution = 0
                m.h_points = int(m.h_points * (1-phi))
                m.aggression += aggression_gain_on_death
                # keep m alive but reset state (or you can simulate removal then respawn)
                # to model brief death, do nothing else

    # H reproduction (simple)
    newborns = []
    for h in list(H_pop):
        if random.random() < r_H:
            # child inherits knowledge with p_transmit
            k = h.knowledge if random.random() < p_transmit else h.knowledge * 0.2
            newborns.append(H(knowledge = max(0.0, k * 0.9)))
        # small chance knowledge increases slightly with survival
        h.knowledge = min(1.0, h.knowledge + 0.001)
    H_pop.extend(newborns)

    # small M spawn (rare)
    if random.random() < 0.01:
        M_pop.append(M(skill=0.05))

    # tidy small floats
    if tick % 50 == 0:
        print(f"tick {tick:04d}  H={len(H_pop):04d}  M={len(M_pop):03d}  avg_H_know={statistics.mean([h.knowledge for h in H_pop]) if H_pop else 0:.3f}")

# final
print("Final: H=", len(H_pop), " M=", len(M_pop))
